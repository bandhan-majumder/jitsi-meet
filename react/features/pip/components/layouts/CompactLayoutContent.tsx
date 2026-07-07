import React, { RefObject } from 'react';

interface IProps {
    avatar?: React.ReactNode;
    displayName: string;
    keepVideoMounted?: boolean;
    showAvatar: boolean;
    videoRef?: RefObject<HTMLVideoElement>;
}

/**
 * Shared compact PiP layout. The caller provides either a video ref or an
 * avatar fallback, depending on where the layout is rendered.
 *
 * @param {IProps} props - Component props.
 * @returns {React.ReactElement}
 */
const CompactLayoutContent = ({
    avatar,
    displayName,
    keepVideoMounted = false,
    showAvatar,
    videoRef
}: IProps) => (
    <div className = 'doc-pip-compact-layout'>
        {(!showAvatar || keepVideoMounted) && (
            <video
                autoPlay = { true }
                className = 'doc-pip-video-element'
                hidden = { showAvatar }
                muted = { true }
                playsInline = { true }
                ref = { videoRef } />
        )}
        {showAvatar && (
            <div className = 'doc-pip-avatar-placeholder'>
                {avatar}
            </div>
        )}
        <div className = 'doc-pip-participant-name'>{displayName}</div>
    </div>
);

export default CompactLayoutContent;
