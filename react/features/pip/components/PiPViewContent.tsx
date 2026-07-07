import React from 'react';

interface IProps {
    controls: React.ReactNode;
    layout: React.ReactNode;
}

/**
 * Shared Document PiP shell used by both the in-app portal and the embedded
 * renderer.
 *
 * @param {IProps} props - Component props.
 * @returns {React.ReactElement}
 */
const PiPViewContent = ({ controls, layout }: IProps) => (
    <div className = 'doc-pip-container'>
        <div className = 'doc-pip-video-area'>
            <div className = 'doc-pip-videos-container'>
                {layout}
            </div>
            <div className = 'doc-pip-controls'>
                {controls}
            </div>
        </div>
    </div>
);

export default PiPViewContent;
