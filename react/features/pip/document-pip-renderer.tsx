import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import Icon from '../base/icons/components/Icon';
import IconHangup from '../base/icons/svg/hangup.svg';
import IconMicSlash from '../base/icons/svg/mic-slash.svg';
import IconMic from '../base/icons/svg/mic.svg';
import IconVideoOff from '../base/icons/svg/video-off.svg';
import IconVideo from '../base/icons/svg/video.svg';

import PiPViewContent from './components/PiPViewContent';
import CompactLayoutContent from './components/layouts/CompactLayoutContent';

const MESSAGE_TYPE = 'jitsi-document-pip';
const CONNECTION_RETRY_TIMEOUT = 5000;
const COMMAND_PENDING_TIMEOUT = 2500;

interface IState {
    audioDisabled?: boolean;
    audioMuted?: boolean;
    audioPending?: boolean;
    connectionState?: string;
    displayName?: string;
    videoDisabled?: boolean;
    videoMuted?: boolean;
    videoPending?: boolean;
}

type IconName = 'camera' | 'camera-off' | 'hangup' | 'mic' | 'mic-off';
type PendingControl = 'audio' | 'video';

let rendererPort: MessagePort | undefined;

function post(name: string, data?: any) {
    const message = {
        data,
        name,
        type: MESSAGE_TYPE
    };

    if (rendererPort) {
        rendererPort.postMessage(message);

        return;
    }

    window.parent.postMessage(message, '*');
}

function getIcon(name: IconName) {
    switch (name) {
    case 'camera':
        return IconVideo;
    case 'camera-off':
        return IconVideoOff;
    case 'hangup':
        return IconHangup;
    case 'mic':
        return IconMic;
    case 'mic-off':
        return IconMicSlash;
    }
}

function renderControlButton({
    className = '',
    disabled = false,
    icon,
    onClick,
    pending = false,
    label,
    toggled = false
}: {
    className?: string;
    disabled?: boolean;
    icon: IconName;
    label: string;
    onClick: () => void;
    pending?: boolean;
    toggled?: boolean;
}) {
    const isDisabled = disabled || pending;
    const handleClick = () => {
        if (!isDisabled) {
            onClick();
        }
    };
    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handleClick();
        }
    };

    return (
        <div
            aria-disabled = { isDisabled }
            aria-label = { label }
            aria-pressed = { toggled }
            className = 'toolbox-button'
            onClick = { handleClick }
            onKeyDown = { handleKeyDown }
            role = 'button'
            tabIndex = { isDisabled ? -1 : 0 }
            title = { label }>
            <div className = { `toolbox-icon ${toggled ? 'toggled' : ''} ${isDisabled ? 'disabled' : ''} ${className}` }>
                <Icon
                    size = { 24 }
                    src = { getIcon(icon) } />
            </div>
        </div>
    );
}

function DocumentPiPRenderer() {
    const [ state, setState ] = useState<IState>({});
    const [ connected, setConnected ] = useState(false);
    const [ pendingControls, setPendingControls ] = useState<Record<PendingControl, boolean>>({
        audio: false,
        video: false
    });
    const videoRef = useRef<HTMLVideoElement>(null);
    const pendingIceCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
    const pendingControlTimersRef = useRef<Record<PendingControl, number | undefined>>({
        audio: undefined,
        video: undefined
    });
    const expectedControlStateRef = useRef<Record<PendingControl, boolean | undefined>>({
        audio: undefined,
        video: undefined
    });
    const peerConnectionRef = useRef<RTCPeerConnection>();
    const reconnectTimerRef = useRef<number>();
    const onHangupClick = useCallback(() => post('command', 'hangup'), []);

    const clearPendingControl = useCallback((control: PendingControl) => {
        const timer = pendingControlTimersRef.current[control];

        if (timer) {
            window.clearTimeout(timer);
            pendingControlTimersRef.current[control] = undefined;
        }

        expectedControlStateRef.current[control] = undefined;
        setPendingControls(current => ({
            ...current,
            [control]: false
        }));
    }, []);

    const markPendingControl = useCallback((control: PendingControl, expectedState: boolean) => {
        clearPendingControl(control);
        expectedControlStateRef.current[control] = expectedState;
        setPendingControls(current => ({
            ...current,
            [control]: true
        }));
        pendingControlTimersRef.current[control] = window.setTimeout(() => {
            clearPendingControl(control);
        }, COMMAND_PENDING_TIMEOUT);
    }, [ clearPendingControl ]);

    const onAudioClick = useCallback(() => {
        markPendingControl('audio', !Boolean(state.audioMuted));
        post('command', 'toggle-audio');
    }, [ markPendingControl, state.audioMuted ]);

    const onVideoClick = useCallback(() => {
        markPendingControl('video', !Boolean(state.videoMuted));
        post('command', 'toggle-video');
    }, [ markPendingControl, state.videoMuted ]);

    useEffect(() => {
        const clearReconnectTimer = () => {
            if (reconnectTimerRef.current) {
                window.clearTimeout(reconnectTimerRef.current);
                reconnectTimerRef.current = undefined;
            }
        };

        const scheduleReconnect = () => {
            clearReconnectTimer();
            reconnectTimerRef.current = window.setTimeout(() => {
                post('reconnect');
            }, CONNECTION_RETRY_TIMEOUT);
        };

        const closePeerConnection = () => {
            peerConnectionRef.current?.close();
            peerConnectionRef.current = undefined;
            pendingIceCandidatesRef.current = [];
            setConnected(false);
        };

        async function handleOffer(data: RTCSessionDescriptionInit | {
            offer: RTCSessionDescriptionInit;
            rtcConfig?: RTCConfiguration;
        }) {
            const offer = 'offer' in data ? data.offer : data;
            const rtcConfig = 'offer' in data ? data.rtcConfig : undefined;

            closePeerConnection();
            scheduleReconnect();

            const peerConnection = new RTCPeerConnection(rtcConfig);

            peerConnectionRef.current = peerConnection;
            peerConnection.ontrack = event => {
                if (videoRef.current) {
                    videoRef.current.srcObject = event.streams[0];
                }
            };
            peerConnection.onicecandidate = event => {
                if (event.candidate) {
                    post('ice', event.candidate.toJSON());
                }
            };

            const reportConnectionState = () => {
                const connectionState = peerConnection.connectionState;
                const iceConnectionState = peerConnection.iceConnectionState;

                post('connection-state', {
                    connectionState,
                    iceConnectionState
                });

                if (connectionState === 'connected'
                        || iceConnectionState === 'connected' || iceConnectionState === 'completed') {
                    clearReconnectTimer();
                    setConnected(true);
                } else if (connectionState === 'failed' || connectionState === 'disconnected'
                        || iceConnectionState === 'failed' || iceConnectionState === 'disconnected') {
                    setConnected(false);
                    scheduleReconnect();
                }
            };

            peerConnection.onconnectionstatechange = reportConnectionState;
            peerConnection.oniceconnectionstatechange = reportConnectionState;

            try {
                await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));

                const answer = await peerConnection.createAnswer();

                await peerConnection.setLocalDescription(answer);

                while (pendingIceCandidatesRef.current.length) {
                    const candidate = pendingIceCandidatesRef.current.shift();

                    if (candidate) {
                        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                    }
                }

                post('answer', answer);
            } catch (error) {
                post('connection-state', {
                    connectionState: 'failed',
                    error: error instanceof Error ? error.message : String(error)
                });
                scheduleReconnect();
            }
        }

        const handleMessage = (message: any) => {
            if (message?.type !== MESSAGE_TYPE) {
                return;
            }

            const { data, name } = message;

            switch (name) {
            case 'state': {
                const nextState = data ?? {};

                setState(nextState);

                if (expectedControlStateRef.current.audio === nextState.audioMuted || nextState.audioPending) {
                    clearPendingControl('audio');
                }

                if (expectedControlStateRef.current.video === nextState.videoMuted || nextState.videoPending) {
                    clearPendingControl('video');
                }
                break;
            }
            case 'offer':
                handleOffer(data);
                break;
            case 'ice':
                if (peerConnectionRef.current?.remoteDescription) {
                    peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(data)).catch(error => {
                        post('connection-state', {
                            connectionState: 'failed',
                            error: error instanceof Error ? error.message : String(error)
                        });
                    });
                } else {
                    pendingIceCandidatesRef.current.push(data);
                }
                break;
            }
        };

        const listener = (event: MessageEvent) => {
            if (event.data?.type !== MESSAGE_TYPE) {
                return;
            }

            if (event.data.name === 'init' && event.ports[0]) {
                rendererPort = event.ports[0];
                rendererPort.onmessage = portEvent => handleMessage(portEvent.data);
                rendererPort.start();
                post('ready');

                return;
            }

            handleMessage(event.data);
        };

        window.addEventListener('message', listener);
        post('ready');

        return () => {
            clearReconnectTimer();
            window.removeEventListener('message', listener);
            rendererPort?.close();
            rendererPort = undefined;
            closePeerConnection();
            clearPendingControl('audio');
            clearPendingControl('video');
        };
    }, [ clearPendingControl ]);

    const participantName = state.displayName || 'Jitsi Meet';
    const showAvatar = state.videoMuted || !connected;
    const audioDisabled = Boolean(state.audioDisabled || state.audioPending || pendingControls.audio);
    const videoDisabled = Boolean(state.videoDisabled || state.videoPending || pendingControls.video);

    return (
        <PiPViewContent
            controls = { <>
                {renderControlButton({
                    disabled: audioDisabled,
                    icon: state.audioMuted ? 'mic-off' : 'mic',
                    label: state.audioMuted ? 'Unmute microphone' : 'Mute microphone',
                    onClick: onAudioClick,
                    pending: pendingControls.audio,
                    toggled: state.audioMuted
                })}
                {renderControlButton({
                    disabled: videoDisabled,
                    icon: state.videoMuted ? 'camera-off' : 'camera',
                    label: state.videoMuted ? 'Start camera' : 'Stop camera',
                    onClick: onVideoClick,
                    pending: pendingControls.video,
                    toggled: state.videoMuted
                })}
                {renderControlButton({
                    className: 'hangup-button',
                    icon: 'hangup',
                    label: 'Leave meeting',
                    onClick: onHangupClick
                })}
            </> }
            layout = { <CompactLayoutContent
                avatar = { participantName.slice(0, 1).toUpperCase() }
                displayName = { participantName }
                keepVideoMounted = { true }
                showAvatar = { showAvatar }
                videoRef = { videoRef } /> } />
    );
}

const root = createRoot(document.getElementById('react') as HTMLElement);

root.render(<DocumentPiPRenderer />);
