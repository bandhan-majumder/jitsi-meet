import { IReduxState } from '../app/types';
import { MEDIA_TYPE } from '../base/media/constants';
import { IGUMPendingState } from '../base/media/types';
import { getLocalParticipant, getParticipantDisplayName } from '../base/participants/functions';
import { isLocalTrackMuted } from '../base/tracks/functions.any';
import { getLargeVideoParticipant } from '../large-video/functions';
import { isPrejoinPageVisible } from '../prejoin/functions.any';
import { isAudioMuteButtonDisabled, isVideoMuteButtonDisabled } from '../toolbox/functions';

import logger from './logger';

const DOC_PIP_EVENT_PREFIX = 'jitsi-document-pip';

let peerConnection: RTCPeerConnection | undefined;
let peerConnectionTrackIds = '';
let remoteDescriptionSet = false;
let reconnectTimer: number | undefined;
const pendingIceCandidates: RTCIceCandidateInit[] = [];
const RECONNECT_DELAY = 1000;
const STREAM_WAIT_RETRIES = 20;
const STREAM_WAIT_INTERVAL = 250;

export enum EmbeddedDocumentPiPLifecycle {
    ACTIVE = 'active',
    IDLE = 'idle',
    REQUESTED = 'requested'
}

let lifecycle = EmbeddedDocumentPiPLifecycle.IDLE;

export interface IDocumentPiPMessage {
    data?: any;
    name: string;
}

function notify(name: string, data?: any) {
    if (!APP.API?._sendEvent) {
        return;
    }

    APP.API._sendEvent({
        data,
        name
    });
}

function closePeerConnection() {
    if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
    }
    if (peerConnection) {
        peerConnection.close();
        peerConnection = undefined;
    }
    peerConnectionTrackIds = '';
    remoteDescriptionSet = false;
    pendingIceCandidates.length = 0;
}

function getRTCConfig(): RTCConfiguration {
    const state = APP.store?.getState?.();
    const stunServers = state?.['features/base/config']?.p2p?.stunServers;

    if (Array.isArray(stunServers) && stunServers.length) {
        return {
            iceServers: stunServers as RTCIceServer[]
        };
    }

    return {};
}

function getPiPStream(): MediaStream | undefined {
    const video = document.getElementById('pipVideo') as HTMLVideoElement | null;
    const stream = video?.srcObject as MediaStream | null;
    const captureStream = (video as (HTMLVideoElement & { captureStream?: () => MediaStream; }) | null)?.captureStream;

    if (stream) {
        return stream;
    }

    if (captureStream) {
        return captureStream.call(video);
    }

    return undefined;
}

function hasLiveTracks(stream: MediaStream | undefined) {
    return Boolean(stream?.getTracks().some(track => track.readyState === 'live'));
}

async function waitForPiPStream() {
    for (let i = 0; i < STREAM_WAIT_RETRIES; i++) {
        const stream = getPiPStream();

        if (hasLiveTracks(stream)) {
            return stream;
        }

        await new Promise(resolve => {
            window.setTimeout(resolve, STREAM_WAIT_INTERVAL);
        });
    }

    return undefined;
}

export function isEmbeddedDocumentPiPEnabled(state: IReduxState): boolean {
    const embedMode = state['features/base/config']?.pip?.documentPiP?.embedMode;

    return embedMode !== 'disabled';
}

export function requestEmbeddedDocumentPiP(state: IReduxState, reason?: string) {
    if (!isEmbeddedDocumentPiPEnabled(state)) {
        return false;
    }

    const docPiPConfig = state['features/base/config']?.pip?.documentPiP?.windowOptions;

    sendEmbeddedDocumentPiPAvailability(true);
    notify('_document-pip-requested', {
        options: {
            width: docPiPConfig?.width ?? 600,
            height: docPiPConfig?.height ?? 450,
            disallowReturnToOpener: docPiPConfig?.disallowReturnToOpener ?? false,
            preferInitialWindowPlacement: docPiPConfig?.preferInitialWindowPlacement ?? false
        },
        reason
    });
    lifecycle = EmbeddedDocumentPiPLifecycle.REQUESTED;

    return true;
}

export function sendEmbeddedDocumentPiPAvailability(available: boolean) {
    notify('_document-pip-availability', {
        available,
        type: `${DOC_PIP_EVENT_PREFIX}-availability`
    });
}

export function closeEmbeddedDocumentPiP() {
    notify('_document-pip-close');
    lifecycle = EmbeddedDocumentPiPLifecycle.IDLE;
    closePeerConnection();
}

export function setEmbeddedDocumentPiPActive() {
    lifecycle = EmbeddedDocumentPiPLifecycle.ACTIVE;
}

export function setEmbeddedDocumentPiPIdle() {
    lifecycle = EmbeddedDocumentPiPLifecycle.IDLE;
}

export function isEmbeddedDocumentPiPActive() {
    return lifecycle === EmbeddedDocumentPiPLifecycle.ACTIVE;
}

export async function startEmbeddedDocumentPiPStream() {
    closePeerConnection();

    const stream = await waitForPiPStream();
    const rtcConfig = getRTCConfig();

    if (!stream) {
        logger.warn('Embedded Document PiP stream unavailable');
        notify('_document-pip-state', {
            connectionState: 'waiting-for-stream',
            type: `${DOC_PIP_EVENT_PREFIX}-state`
        });
        scheduleEmbeddedDocumentPiPReconnect();

        return false;
    }

    peerConnectionTrackIds = stream.getTracks().map(track => track.id).join(',');
    peerConnection = new RTCPeerConnection(rtcConfig);

    stream.getTracks().forEach(track => peerConnection?.addTrack(track, stream));

    peerConnection.onicecandidate = event => {
        if (event.candidate) {
            notify('_document-pip-ice', event.candidate.toJSON());
        }
    };
    peerConnection.onconnectionstatechange = () => {
        const connectionState = peerConnection?.connectionState;

        if (connectionState === 'failed' || connectionState === 'disconnected') {
            scheduleEmbeddedDocumentPiPReconnect();
        }
    };
    peerConnection.oniceconnectionstatechange = () => {
        const iceConnectionState = peerConnection?.iceConnectionState;

        if (iceConnectionState === 'failed' || iceConnectionState === 'disconnected') {
            scheduleEmbeddedDocumentPiPReconnect();
        }
    };

    const offer = await peerConnection.createOffer();

    await peerConnection.setLocalDescription(offer);
    notify('_document-pip-state', {
        connectionState: 'connecting',
        type: `${DOC_PIP_EVENT_PREFIX}-state`
    });
    notify('_document-pip-offer', {
        offer,
        rtcConfig
    });

    return true;
}

export function scheduleEmbeddedDocumentPiPReconnect() {
    if (lifecycle !== EmbeddedDocumentPiPLifecycle.ACTIVE || reconnectTimer) {
        return;
    }

    reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        startEmbeddedDocumentPiPStream().catch(error => {
            logger.error('Failed to reconnect embedded Document PiP stream:', error);
        });
    }, RECONNECT_DELAY);
}

export async function refreshEmbeddedDocumentPiPStream() {
    if (!peerConnection) {
        return;
    }

    const stream = getPiPStream();
    const trackIds = stream?.getTracks().map(track => track.id).join(',') ?? '';

    if (trackIds && trackIds !== peerConnectionTrackIds) {
        await startEmbeddedDocumentPiPStream();
    }
}

export async function handleEmbeddedDocumentPiPAnswer(answer: RTCSessionDescriptionInit) {
    if (!peerConnection) {
        return;
    }

    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    remoteDescriptionSet = true;

    while (pendingIceCandidates.length) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(pendingIceCandidates.shift()));
    }
}

export function handleEmbeddedDocumentPiPConnectionState(state: {
    connectionState?: RTCPeerConnectionState | string;
    error?: string;
    iceConnectionState?: RTCIceConnectionState | string;
}) {
    logger.debug('Embedded Document PiP renderer connection state:', state);

    if (state?.connectionState === 'failed' || state?.connectionState === 'disconnected'
            || state?.iceConnectionState === 'failed' || state?.iceConnectionState === 'disconnected') {
        notify('_document-pip-state', {
            connectionState: 'reconnecting',
            type: `${DOC_PIP_EVENT_PREFIX}-state`
        });
        scheduleEmbeddedDocumentPiPReconnect();
    }
}

export async function handleEmbeddedDocumentPiPIce(candidate: RTCIceCandidateInit) {
    if (!peerConnection) {
        return;
    }

    if (!remoteDescriptionSet) {
        pendingIceCandidates.push(candidate);

        return;
    }

    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
}

export function handleEmbeddedDocumentPiPClosed() {
    setEmbeddedDocumentPiPIdle();
    closePeerConnection();
}

export function getEmbeddedDocumentPiPState(state: IReduxState) {
    const isOnPrejoin = isPrejoinPageVisible(state);
    const participant = isOnPrejoin ? getLocalParticipant(state) : getLargeVideoParticipant(state);
    const displayName = participant?.id
        ? getParticipantDisplayName(state, participant.id)
        : participant?.name ?? '';
    const tracks = state['features/base/tracks'];
    const media = state['features/base/media'];

    return {
        audioDisabled: isAudioMuteButtonDisabled(state),
        audioMuted: isLocalTrackMuted(tracks, MEDIA_TYPE.AUDIO),
        audioPending: media.audio.gumPending !== IGUMPendingState.NONE,
        displayName,
        participantId: participant?.id,
        type: `${DOC_PIP_EVENT_PREFIX}-state`,
        videoDisabled: isVideoMuteButtonDisabled(state),
        videoPending: media.video.gumPending !== IGUMPendingState.NONE,
        videoMuted: isLocalTrackMuted(tracks, MEDIA_TYPE.VIDEO)
    };
}

export function sendEmbeddedDocumentPiPState(state: IReduxState) {
    notify('_document-pip-state', getEmbeddedDocumentPiPState(state));
}
