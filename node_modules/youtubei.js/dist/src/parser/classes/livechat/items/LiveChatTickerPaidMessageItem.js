import Author from '../../misc/Author.js';
import { Parser } from '../../../index.js';
import NavigationEndpoint from '../../NavigationEndpoint.js';
import Text from '../../misc/Text.js';
import { YTNode } from '../../../helpers.js';
class LiveChatTickerPaidMessageItem extends YTNode {
    constructor(data) {
        super();
        this.author = new Author(data.authorName, data.authorBadges, data.authorPhoto, data.authorExternalChannelId);
        this.amount = new Text(data.amount);
        this.duration_sec = data.durationSec;
        this.full_duration_sec = data.fullDurationSec;
        this.show_item = Parser.parseItem(data.showItemEndpoint?.showLiveChatItemEndpoint?.renderer);
        this.show_item_endpoint = new NavigationEndpoint(data.showItemEndpoint);
        this.id = data.id;
    }
}
LiveChatTickerPaidMessageItem.type = 'LiveChatTickerPaidMessageItem';
export default LiveChatTickerPaidMessageItem;
