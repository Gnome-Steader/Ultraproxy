import { YTNode } from '../helpers.js';
import { Parser } from '../index.js';
import NavigationEndpoint from './NavigationEndpoint.js';
import AvatarView from './AvatarView.js';
class DecoratedAvatarView extends YTNode {
    constructor(data) {
        super();
        this.avatar = Parser.parseItem(data.avatar, AvatarView);
        this.a11y_label = data.a11yLabel;
        if (data.rendererContext?.commandContext?.onTap) {
            this.on_tap_endpoint = new NavigationEndpoint(data.rendererContext.commandContext.onTap);
        }
    }
}
DecoratedAvatarView.type = 'DecoratedAvatarView';
export default DecoratedAvatarView;
