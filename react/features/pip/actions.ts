import { IStore } from '../app/types';
import { leaveConference } from '../base/conference/actions';
import { MEDIA_TYPE } from '../base/media/constants';
import { isLocalTrackMuted } from '../base/tracks/functions.any';
import { isEmbedded } from '../base/util/embedUtils';
import { handleToggleVideoMuted } from '../toolbox/actions.any';
import { muteLocal } from '../video-menu/actions.any';

import { SET_PIP_ACTIVE } from './actionTypes';
import {
    closeEmbeddedDocumentPiP,
    handleEmbeddedDocumentPiPClosed,
    handleEmbeddedDocumentPiPConnectionState,
    requestEmbeddedDocumentPiP,
    scheduleEmbeddedDocumentPiPReconnect,
    sendEmbeddedDocumentPiPAvailability,
    sendEmbeddedDocumentPiPState,
    setEmbeddedDocumentPiPActive,
    setEmbeddedDocumentPiPIdle,
    startEmbeddedDocumentPiPStream
} from './embedded';
import {
    cleanupMediaSessionHandlers,
    clearPiPWindow,
    enterVideoPiP,
    getStoredPiPWindow,
    initPiPWindow,
    setupMediaSessionHandlers,
    shouldShowPiP,
} from './functions';
import logger from './logger';
import { getDocumentPiPWindow, isDocumentPiPOpen, isDocumentPiPSupported } from "./utils";

/**
 * Flag to track if a Document PiP request is currently pending.
 * Prevents duplicate requestWindow() calls before the first one resolves.
 */
let docPiPPending = false;

/**
 * Action to set Picture-in-Picture active state.
 *
 * @param {boolean} isPiPActive - Whether PiP is active.
 * @returns {{
 *     type: SET_PIP_ACTIVE,
 *     isPiPActive: boolean
 * }}
 */
export function setPiPActive(isPiPActive: boolean) {
    return {
        type: SET_PIP_ACTIVE,
        isPiPActive
    };
}

/**
 * Toggles audio mute from PiP MediaSession controls.
 * Uses exact same logic as toolbar audio button including GUM pending state.
 *
 * @returns {Function}
 */
export function toggleAudioFromPiP() {
    return (dispatch: IStore['dispatch'], getState: IStore['getState']) => {
        const state = getState();
        const audioMuted = isLocalTrackMuted(state['features/base/tracks'], MEDIA_TYPE.AUDIO);

        // Use the exact same action as toolbar button.
        dispatch(muteLocal(!audioMuted, MEDIA_TYPE.AUDIO));
    };
}

/**
 * Toggles video mute from PiP MediaSession controls.
 * Uses exact same logic as toolbar video button including GUM pending state.
 *
 * @returns {Function}
 */
export function toggleVideoFromPiP() {
    return (dispatch: IStore['dispatch'], getState: IStore['getState']) => {
        const state = getState();
        const videoMuted = isLocalTrackMuted(state['features/base/tracks'], MEDIA_TYPE.VIDEO);

        // Use the exact same action as toolbar button (showUI=true, ensureTrack=true).
        dispatch(handleToggleVideoMuted(!videoMuted, true, true));
    };
}

/**
 * Action to exit Picture-in-Picture mode.
 * Handles both Document PiP and Video PiP.
 *
 * @returns {Function}
 */
export function exitPiP() {
    return (dispatch: IStore['dispatch']) => {
        logger.debug('exitPiP called');

        if (isEmbedded()) {
            closeEmbeddedDocumentPiP();
        }

        const pipWindow = getStoredPiPWindow();

        if (pipWindow && !pipWindow.closed) {
            pipWindow.close();
            clearPiPWindow();
        }

        if (document.pictureInPictureElement) {
            document.exitPictureInPicture()
                .then(() => {
                logger.debug('Exited Picture-in-Picture mode');
                })
                .catch((err: Error) => {
                    logger.error(`Error while exiting PiP: ${err.message}`);
                });
        }

        dispatch(setPiPActive(false));
        cleanupMediaSessionHandlers();
    };
}

/**
 * Action to handle window blur or tab switch.
 * Enters PiP mode if not already active.
 *
 * @param {HTMLVideoElement} videoElement - The video element we will use for PiP.
 * @returns {Function}
 */
export function handleWindowBlur(videoElement: HTMLVideoElement) {
    return (_dispatch: IStore['dispatch'], getState: IStore['getState']) => {
        const state = getState();
        const isPiPActive = state['features/pip']?.isPiPActive;

        logger.debug(`Window blur detected, isPiPActive=${isPiPActive}`);

        if (!isPiPActive) {
            enterVideoPiP(videoElement);
        }
    };
}

/**
 * Action to handle window focus.
 * Exits PiP mode if currently active (matches old AOT behavior).
 *
 * @returns {Function}
 */
export function handleWindowFocus() {
    return (dispatch: IStore['dispatch'], getState: IStore['getState']) => {
        const state = getState();
        const isPiPActive = state['features/pip']?.isPiPActive;

        logger.debug(`Window focus detected, isPiPActive=${isPiPActive}`);

        if (isPiPActive) {
            dispatch(exitPiP());
        }
    };
}

/**
 * Action to handle the browser's leavepictureinpicture event.
 * Updates state and cleans up MediaSession handlers.
 *
 * @returns {Function}
 */
export function handlePiPLeaveEvent() {
    return (dispatch: IStore['dispatch']) => {
        logger.log('Left Picture-in-Picture mode');

        dispatch(setPiPActive(false));
        cleanupMediaSessionHandlers();
        APP.API.notifyPictureInPictureLeft();
    };
}

/**
 * Action to handle the browser's enterpictureinpicture event.
 * Updates state and sets up MediaSession handlers.
 *
 * @returns {Function}
 */
export function handlePipEnterEvent() {
    return (dispatch: IStore['dispatch']) => {
        logger.log('Entered Picture-in-Picture mode');

        dispatch(setPiPActive(true));
        setupMediaSessionHandlers(dispatch);
        APP.API.notifyPictureInPictureEntered();
    };
}

/**
 * Shows Picture-in-Picture window.
 * Called from external API when iframe becomes not visible (IntersectionObserver).
 *
 * @returns {Function}
 */
export function showPiP() {
    return (dispatch: IStore['dispatch'], getState: IStore['getState']) => {
        const state = getState();
        const isPiPActive = state['features/pip']?.isPiPActive;
        const _shouldShowPip = shouldShowPiP(state);

        logger.debug(`showPiP called, shouldShow=${_shouldShowPip}, isPiPActive=${isPiPActive}`);

        if (!_shouldShowPip) {
            return;
        }

        if (!isPiPActive) {
            if (isEmbedded() || isDocumentPiPSupported()) {
                dispatch(openDocumentPiP());
            } else {
                const videoElement = document.getElementById('pipVideo') as HTMLVideoElement;

                if (!videoElement) {
                    logger.warn('showPiP: pipVideo element not found');

                    return;
                }

                enterVideoPiP(videoElement);
            }
        }
    };
}

/**
 * Hides Picture-in-Picture window.
 * Called from external API when iframe becomes visible.
 *
 * @returns {Function}
 */
export function hidePiP() {
    return (dispatch: IStore['dispatch'], getState: IStore['getState']) => {
        const state = getState();
        const isPiPActive = state['features/pip']?.isPiPActive;

        logger.debug(`hidePiP called, isPiPActive=${isPiPActive}`);

        if (isPiPActive) {
            dispatch(exitPiP());
        }
    };
}

export function enterPiP() {
    return (dispatch: IStore['dispatch'], getState: IStore['getState']) => {
        if (isEmbedded()) {
            if (getState()['features/pip']?.isPiPActive) {
                dispatch(exitPiP());
            } else {
                dispatch(openDocumentPiP());
            }

            return;
        }

        if (isDocumentPiPSupported()) {
            const pipWindow = getDocumentPiPWindow();

            if (pipWindow) {
                dispatch(exitPiP());
            } else {
                dispatch(openDocumentPiP());
            }
        } else {
            const videoElement = document.getElementById("pipVideo") as HTMLVideoElement;

            if (videoElement) {
                enterVideoPiP(videoElement);
            }
        }
    };
}

export function openDocumentPiP(reason?: string) {
    return (dispatch: IStore['dispatch'], getState: IStore['getState']) => {
        const state = getState();
        const pipConfig = state['features/base/config']?.pip;
        const docPiPConfig = pipConfig?.documentPiP?.windowOptions;

        if (isEmbedded()) {
            if (!shouldShowPiP(state)) {
                sendEmbeddedDocumentPiPAvailability(false);

                return;
            }

            if (docPiPPending) {
                logger.debug('Embedded Document PiP request already pending, skipping duplicate request');

                return;
            }

            docPiPPending = requestEmbeddedDocumentPiP(state, reason);

            return;
        }

        if (!isDocumentPiPSupported()) {
            logger.warn("Document Picture-in-Picture not supported, use Video PiP button");

            return;
        }

        if (isDocumentPiPOpen() || getStoredPiPWindow()) {
            return;
        }

        if (docPiPPending) {
            logger.debug('Document PiP request already pending, skipping duplicate request');

            return;
        }

        const docPiP = (window as any).documentPictureInPicture;

        if (!docPiP) {
            logger.warn("Document Picture-in-Picture not available");

            return;
        }

        docPiPPending = true;

        try {
            const promise = docPiP.requestWindow({
                width: docPiPConfig?.width ?? 600,
                height: docPiPConfig?.height ?? 450,
                disallowReturnToOpener: docPiPConfig?.disallowReturnToOpener ?? false,
                preferInitialWindowPlacement: docPiPConfig?.preferInitialWindowPlacement ?? false,
            });

            return promise
                .then((pipWindow: Window) => {
                    initPiPWindow(pipWindow);

                    dispatch(setPiPActive(true));

                    pipWindow.addEventListener("pagehide", () => {
                        clearPiPWindow();
                        dispatch(setPiPActive(false));
                    });
                })
                .catch((error: Error) => {
                    logger.error("Failed to open Document PiP:", error);
                    dispatch(setPiPActive(false));

                    throw error;
                })
                .finally(() => {
                    docPiPPending = false;
                });
        } catch (error) {
            docPiPPending = false;
            logger.error('Failed to open Document PiP:', error);
            dispatch(setPiPActive(false));

            throw error;
        }
    };
}

export function handleEmbeddedDocumentPiPOpened() {
    return async (dispatch: IStore['dispatch'], getState: IStore['getState']) => {
        const state = getState();

        docPiPPending = false;

        if (!shouldShowPiP(state)) {
            closeEmbeddedDocumentPiP();
            setEmbeddedDocumentPiPIdle();

            return;
        }

        setEmbeddedDocumentPiPActive();
        dispatch(setPiPActive(true));
        APP.API.notifyPictureInPictureEntered();
        sendEmbeddedDocumentPiPAvailability(true);
        sendEmbeddedDocumentPiPState(state);

        try {
            const streamStarted = await startEmbeddedDocumentPiPStream();

            if (!streamStarted) {
                logger.warn('Embedded Document PiP opened before stream was ready; waiting for retry');
            }
        } catch (error) {
            logger.error('Failed to start embedded Document PiP stream:', error);
            scheduleEmbeddedDocumentPiPReconnect();
            sendEmbeddedDocumentPiPState(getState());
        }
    };
}

export function handleEmbeddedDocumentPiPOpenFailed(error?: { reason?: string; }) {
    return (dispatch: IStore['dispatch'], getState: IStore['getState']) => {
        docPiPPending = false;
        logger.warn('Embedded Document PiP open failed:', error?.reason);
        setEmbeddedDocumentPiPIdle();
        dispatch(setPiPActive(false));
        sendEmbeddedDocumentPiPAvailability(shouldShowPiP(getState()));
    };
}

export function handleEmbeddedDocumentPiPWindowClosed() {
    return (dispatch: IStore['dispatch'], getState: IStore['getState']) => {
        docPiPPending = false;
        handleEmbeddedDocumentPiPClosed();
        dispatch(setPiPActive(false));
        sendEmbeddedDocumentPiPAvailability(shouldShowPiP(getState()));
        APP.API.notifyPictureInPictureLeft();
    };
}

export function handleEmbeddedDocumentPiPCommand(command: string) {
    return (dispatch: IStore['dispatch'], getState: IStore['getState']) => {
        switch (command) {
        case 'toggle-audio':
            dispatch(toggleAudioFromPiP());
            window.setTimeout(() => sendEmbeddedDocumentPiPState(getState()), 0);
            break;
        case 'toggle-video':
            dispatch(toggleVideoFromPiP());
            window.setTimeout(() => sendEmbeddedDocumentPiPState(getState()), 0);
            break;
        case 'hangup':
            closeEmbeddedDocumentPiP();
            dispatch(leaveConference());
            break;
        }
    };
}

export function handleEmbeddedDocumentPiPReconnect() {
    return () => {
        scheduleEmbeddedDocumentPiPReconnect();
    };
}

export function handleEmbeddedDocumentPiPConnectionStateChanged(state: {
    connectionState?: string;
    error?: string;
    iceConnectionState?: string;
}) {
    return () => {
        handleEmbeddedDocumentPiPConnectionState(state);
    };
}
