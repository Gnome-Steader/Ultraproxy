import { YTNode } from '../helpers.js';
import { Parser } from '../index.js';
import EngagementPanelSectionList from './EngagementPanelSectionList.js';
import Text from './misc/Text.js';
class DescriptionPreviewView extends YTNode {
    constructor(data) {
        super();
        this.description = Text.fromAttributed(data.description);
        this.max_lines = parseInt(data.maxLines);
        this.truncation_text = Text.fromAttributed(data.truncationText);
        this.always_show_truncation_text = !!data.alwaysShowTruncationText;
        if (data.rendererContext.commandContext?.onTap?.innertubeCommand?.showEngagementPanelEndpoint) {
            const endpoint = data.rendererContext.commandContext?.onTap?.innertubeCommand?.showEngagementPanelEndpoint;
            this.more_endpoint = {
                show_engagement_panel_endpoint: {
                    engagement_panel: Parser.parseItem(endpoint.engagementPanel, EngagementPanelSectionList),
                    engagement_panel_popup_type: endpoint.engagementPanelPresentationConfigs.engagementPanelPopupPresentationConfig.popupType,
                    identifier: {
                        surface: endpoint.identifier.surface,
                        tag: endpoint.identifier.tag
                    }
                }
            };
        }
    }
}
DescriptionPreviewView.type = 'DescriptionPreviewView';
export default DescriptionPreviewView;
