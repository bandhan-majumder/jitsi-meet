import { IReduxState } from '../app/types';
import { MEDIA_TYPE } from '../base/media/constants';
import StateListenerRegistry from '../base/redux/StateListenerRegistry';
import { isLocalTrackMuted } from '../base/tracks/functions.any';
import { isEmbedded } from '../base/util/embedUtils';
import { getElectronGlobalNS } from '../base/util/helpers';

import {
    getEmbeddedDocumentPiPState,
    isEmbeddedDocumentPiPActive,
    refreshEmbeddedDocumentPiPStream,
    sendEmbeddedDocumentPiPAvailability
} from './embedded';
import { requestPictureInPicture, shouldShowPiP, updateMediaSessionState } from './functions';
import logger from './logger';

/**
 * Listens to audio and video mute state changes when PiP is active
 * and updates the MediaSession API to reflect the current state in PiP controls.
 */
StateListenerRegistry.register(
    /* selector */ (state: IReduxState) => {
        // Skip if PiP is disabled or shouldn't be shown (e.g., on prejoin without showOnPrejoin).
        if (!shouldShowPiP(state)) {
            return null;
        }

        const isPiPActive = state['features/pip']?.isPiPActive;

        if (!isPiPActive) {
            return null;
        }

        return {
            audioMuted: isLocalTrackMuted(state['features/base/tracks'], MEDIA_TYPE.AUDIO),
            videoMuted: isLocalTrackMuted(state['features/base/tracks'], MEDIA_TYPE.VIDEO)
        };
    },
    /* listener */ (muteState: { audioMuted: boolean; videoMuted: boolean; } | null) => {
        if (muteState === null) {
            return;
        }

        updateMediaSessionState({
            cameraActive: !muteState.videoMuted,
            microphoneActive: !muteState.audioMuted
        });
    },
    {
        deepEquals: true
    }
);

StateListenerRegistry.register(
    /* selector */ (state: IReduxState) => {
        if (!state['features/pip']?.isPiPActive || !isEmbeddedDocumentPiPActive()) {
            return null;
        }

        return getEmbeddedDocumentPiPState(state);
    },
    /* listener */ (_state: ReturnType<typeof getEmbeddedDocumentPiPState> | null) => {
        if (_state) {
            APP.API._sendEvent({
                data: _state,
                name: '_document-pip-state'
            });
            refreshEmbeddedDocumentPiPStream();
        }
    },
    {
        deepEquals: true
    }
);

StateListenerRegistry.register(
    /* selector */ shouldShowPiP,
    /* listener */ (_shouldShowPiP: boolean) => {
        const electronNS = getElectronGlobalNS();

        if (isEmbedded()) {
            sendEmbeddedDocumentPiPAvailability(_shouldShowPiP);
        }

        if (_shouldShowPiP) {
            // Expose requestPictureInPicture for Electron main process.
            if (!electronNS.requestPictureInPicture) {
                logger.debug('Exposing requestPictureInPicture to Electron namespace');
                electronNS.requestPictureInPicture = requestPictureInPicture;
            }
        } else if (typeof electronNS.requestPictureInPicture === 'function') {
            logger.debug('Removing requestPictureInPicture from Electron namespace (PiP disabled)');
            delete electronNS.requestPictureInPicture;
        }
    }
);

