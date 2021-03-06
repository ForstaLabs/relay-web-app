// vim: ts=4:sw=4:expandtab
/* global platform */

(function () {
    'use strict';

    self.F = self.F || {};

    F.ConversationView = F.ThreadView.extend({
        template: 'views/conversation.html',

        events: {
            'click .f-title-display': 'onTitleClick',
            'click .f-title-edit .icon': 'onTitleEditSubmit',
            'click .f-new-marker': 'onNewMarkerClick',
            'keypress .f-title-edit input': 'onTitleEditKeyPress',
            'blur .f-title-edit': 'onTitleEditBlur',
            'paste': 'onPaste',
            'drop': 'onDrop',
            'dragover': 'onDragOver',
            'dragenter': 'onDragEnter',
            'dragleave': 'onDragLeave',
        },

        initialize: function(options) {
            this.drag_bucket = new Set();
            this.onFocus = this._onFocus.bind(this);
            addEventListener('focus', this.onFocus);
            this.allowCalling = options.allowCalling;
            this.forceScreenSharing = options.forceScreenSharing;
            this.disableCommands = options.disableCommands;
            this.disableMessageInfo = options.disableMessageInfo;
            this.disableSenderInfo = options.disableSenderInfo;
            this.disableRecipientsPrompt = options.disableRecipientsPrompt;
            this.onReadMarksChange = _.debounce(this._onReadMarksChange.bind(this), 200);
            this.pendingMessageStates = {};
            if (self.IntersectionObserver) {
                const cb = this.onNewMessageIntersection.bind(this);
                this.newMessageIntersectionObserver = new IntersectionObserver(cb, {
                    root: this.el,
                    threshold: 0.5
                });
            }
            F.ThreadView.prototype.initialize.apply(this, arguments);
        },

        render: async function() {
            await F.ThreadView.prototype.render.call(this);
            this.messagesView = new F.MessagesView({
                collection: this.model.messages,
                disableMessageInfo: this.disableMessageInfo,
                disableSenderInfo: this.disableSenderInfo
            });
            this.$('.f-messages').prepend(this.messagesView.$el);
            this.messagesView.setScrollElement(this.$('.f-messages')[0]);
            this.listenTo(this.messagesView, 'loadmore', this.onLoadMore);
            this.composeView = new F.ComposeView({
                el: this.$('.f-compose'),
                model: this.model,
                threadView: this
            });
            this.listenTo(this.composeView, 'send', this.onSend);
            await Promise.all([
                this.messagesView.render(),
                this.composeView.render()
            ]);
            this.$dropZone = this.$('.f-dropzone');
            this.listenTo(this.model, 'opened', this.onOpened);
            this.listenTo(this.model, 'closed', this.onClosed);
            this.listenTo(this.model, 'expired', this.onExpired);
            this.listenTo(this.model, 'change:readMarks', this.onReadMarksChange);
            this.listenTo(this.model, 'pendingMessage', this.onPendingMessage);
            this.listenTo(this.model.messages, 'add', this.onAddMessage);
            this.listenTo(this.model.messages, 'add remove', this.onReadMarksChange);
            const loaded = this.model.messages.length;
            const available = await this.model.messages.totalCount();
            const pageSize = this.model.messages.pageSize;
            if (loaded < Math.min(available, pageSize)) {
                await this.loadMore();
            }
            this.onReadMarksChange();
            return this;
        },

        remove: function() {
            removeEventListener('focus', this.onFocus);
            if (this.messagesView) {
                this.messagesView.remove();
            }
            if (this.composeView) {
                this.composeView.remove();
            }
            return F.ThreadView.prototype.remove.apply(this, arguments);
        },

        onClosed: function(e) {
            for (const video of this.$('video')) {
                video.pause();
            }
        },

        _onFocus: function() {
            // Handle clearing unread messages received when window was hidden, but the
            // thread was open.  Hidden varies from platform to platform so its important
            // that we monitor focus state.
            if (!this.isHidden()) {
                this.model.clearUnread();
            }
        },

        onTitleClick: function(ev) {
            this.$('.f-title-display').hide();
            this.$('.f-title-edit').show().find('input').focus();
        },

        onTitleEditSubmit: async function(ev) {
            const $edit = this.$('.f-title-edit');
            const threadTitle = $edit.find('input').val();
            $edit.hide();
            this.$('.f-title-display').show();
            await this.model.save({title: threadTitle});
            await this.model.sendUpdate({threadTitle});
        },

        onNewMarkerClick: function() {
            const $marker = this.$('.f-new-marker');
            const headView = $marker.data('head');
            headView.el.scrollIntoView({behavior: 'smooth'});
        },

        onTitleEditKeyPress: function(ev) {
            if (ev.keyCode === /*enter*/ 13) {
                this.onTitleEditSubmit();
                return false;
            }
        },

        onTitleEditBlur: async function(ev) {
            await F.sleep(1);  // Mostly to let click event win
            this.$('.f-title-edit').hide();
            this.$('.f-title-display').show();
        },

        onPaste: function(ev) {
            const data = ev.originalEvent.clipboardData;
            /* Only handle file attachments and ONLY if there isn't an html option.
             * The HTML option may seem wrong (and it might be) but excel on OSX send
             * cell content as an image in addition to html.  We prefer the html over
             * the image content in this case. */
            if (!(data.files && data.files.length) || data.types.indexOf('text/html') !== -1) {
                return;
            }
            ev.preventDefault();
            this.composeView.fileInput.addFiles(data.files);
            this.focusMessageField(); // Make <enter> key after paste work always.
        },

        onDrop: function(ev) {
            if (!this._dragEventHasFiles(ev)) {
                return;
            }
            ev.preventDefault();
            const data = ev.originalEvent.dataTransfer;
            this.composeView.fileInput.addFiles(data.files);
            if (platform.name !== 'Firefox') {
                this.$dropZone.dimmer('hide');
            }
            this.drag_bucket.clear();
            this.focusMessageField(); // Make <enter> key after drop work always.
        },

        onDragOver: function(ev) {
            if (!this._dragEventHasFiles(ev)) {
                return;
            }
            /* Must prevent default so we can handle drop event ourselves. */
            ev.preventDefault();
        },

        onDragEnter: function(ev) {
            if (!this._dragEventHasFiles(ev) || platform.name === 'Firefox') {
                return;
            }
            this.drag_bucket.add(ev.target);
            if (this.drag_bucket.size === 1) {
                this.$dropZone.dimmer('show');
            }
        },

        onDragLeave: function(ev) {
            if (!this._dragEventHasFiles(ev) || platform.name === 'Firefox') {
                return;
            }
            this.drag_bucket.delete(ev.target);
            if (this.drag_bucket.size === 0) {
                this.$dropZone.dimmer('hide');
            }
        },

        onOpened: async function() {
            this.messagesView.scrollRestore();
            this.focusMessageField();
            for (const video of this.$('video[autoplay][muted]')) {
                video.play().catch(e => null);
            }
            await this.highlightNewMessages();
            this.model.clearUnread();
        },

        focusMessageField: function() {
            if (!F.util.isCoarsePointer()) {
                this.composeView.focusMessageField();
            }
        },

        loadMore: async function() {
            if (this.model.messages.length >= await this.model.messages.totalCount()) {
                return;  // Nothing to fetch
            }
            if (this._loading) {
                console.debug("Debouncing loadMore");
                return;
            }
            this._loading = true;
            try {
                await this.model.messages.fetchPage();
                if (this.model.messages.length) {
                    const last = this.model.messages.at(-1);
                    await this.messagesView.waitAdded(last);
                }
            } finally {
                this._loading = false;
            }
        },

        onLoadMore: async function(messageView) {
            const ctx = messageView.scrollSave();
            await this.loadMore();
            messageView.scrollRestore(ctx);
        },

        onExpired: function(message) {
            var mine = this.model.messages.get(message.id);
            // This is odd, Message gets its own expired event but it might have been
            // triggered on some other Message model (not sure why).  This ensures the
            // expired event is fired on our Message model.
            if (mine && mine.cid !== message.cid) {
                mine.trigger('expired', mine);
            }
        },

        _createReadMarkEl: async function(id) {
            const user = await F.atlas.getContact(id);
            return user && $(`
                <div class="f-read-mark f-avatar f-avatar-image" data-user-id="${id}"
                     title="${user.getName()} has read this far.">
                    <img class="f-user-avatar" src="${await user.getAvatarURL()}"/>
                </div>
            `.trim());
        },

        _onReadMarksChange: async function() {
            await F.queueAsync(`read-marks-${this.cid}`, async () => {
                const readMarks = this.model.get('readMarks') || {};
                await Promise.all(Object.entries(readMarks).map(async ([id, sent]) => {
                    // Exact matches are not always possible, so search up till we find
                    // the last message behind or at the mark.
                    const message = this.model.messages.find(m => m.get('sent') <= sent);
                    const recentlySentByThem = this.model.messages.find(m => m.get('sender') === id);
                    let $mark = this.messagesView.$(`.f-read-mark[data-user-id="${id}"]`);
                    if (!message || (recentlySentByThem && recentlySentByThem.get('sent') > sent)) {
                        if ($mark.length) {
                            $mark.addClass('hidden');
                            await F.util.transitionEnd($mark);
                            $mark.remove();
                        }
                        return;
                    }
                    const msgView = this.messagesView.getItem(message);
                    if (!msgView) {
                        return;
                    }
                    if (!$mark.length) {
                        $mark = await this._createReadMarkEl(id);
                    } else if ($mark.data('target') === msgView) {
                        return;
                    }
                    if (!$mark || !$mark.length) {
                        // Most likely this is an old removed user.
                        return;
                    }
                    $mark.data('target', msgView);
                    msgView.on('render', this.onReadMarksChange);
                    $mark.addClass('hidden');
                    if ($mark[0].isConnected) {
                        await F.util.transitionEnd($mark);
                    }
                    msgView.$('.f-read-marks').prepend($mark);
                    // Check that we aren't superseded by pending activity indicator first..
                    if (!this.getPendingActivity(id).hasClass('active')) {
                        F.util.forceReflow($mark);
                        $mark.removeClass('hidden');
                        await F.util.transitionEnd($mark);
                    }
                }));
            });
        },

        onNewMessageIntersection: function(entries) {
            F.assert(entries.length === 1);
            const entry = entries[0];
            const $newMarker = this.$('.f-new-marker');
            $newMarker.toggleClass('active', !entry.isIntersecting);
        },

        onFirstNewMessageDestroy: function() {
            this.clearNewMessageMarker();
        },

        clearNewMessageMarker: function() {
            const view = this.firstNewMessage;
            if (!view) {
                return;
            }
            this.firstNewMessage = null;
            this.newMessageIntersectionObserver.unobserve(view.el);
            this.stopListening(view.model, 'destroy', this.onFirstNewMessageDestroy);
            this.$('.f-new-marker').removeClass('active');
        },

        highlightNewMessages: async function() {
            const readLevel = this.model.get('readLevel');
            const lastMessage = this.model.messages.at(0);
            for (const item of this.messagesView.getItems()) {
                item.$el.removeClass('new head');
            }
            if (lastMessage && readLevel && readLevel < lastMessage.get('timestamp')) {
                await this.model.messages.fetchToTimestamp(readLevel);
                const newMessages = this.model.messages.filter(x =>
                    x.get('timestamp') > readLevel && x.get('incoming'));
                let item;
                for (const x of newMessages) {
                    item = this.messagesView.getItem(x);
                    item.$el.addClass('new');
                }
                // Last item is actually the head.
                const head = item;
                if (head) {
                    head.$el.addClass('head');
                    if (this.newMessageIntersectionObserver) {
                        this.clearNewMessageMarker();
                        this.firstNewMessage = head;
                        this.newMessageIntersectionObserver.observe(head.el);
                        this.listenTo(head.model, 'destroy', this.onFirstNewMessageDestroy);
                    }
                    this.$('.f-new-marker').data('head', head);
                } else {
                    // No new messages..
                    this.clearNewMessageMarker();
                }
            } else {
                this.clearNewMessageMarker();
            }
        },

        getPendingActivity: function(userId) {
            const $pending = this.$('.f-pending');
            return $pending.find(`.activity[data-user-id="${userId}"]`);
        },

        onPendingMessage: async function(id) {
            let $activity = this.getPendingActivity(id);
            const user = await F.atlas.getContact(id);
            const name = user.getName();
            if (!$activity.length) {
                $activity = $(`
                    <div class="activity radiate f-avatar f-avatar-image"
                         title="${name} is typing..."
                         data-user-id="${id}">
                        <img src="${await user.getAvatarURL()}"/>
                    </div>
                `.trim());
                this.$('.f-pending').append($activity);
                F.util.forceReflow($activity);
            } else {
                $activity.addClass('radiate').attr('title', `${name} is typing...`);
                clearTimeout($activity.data('clearVisualTimeout'));
                clearTimeout($activity.data('clearRadiateTimeout'));
            }
            if (!$activity.hasClass('active')) {
                $activity.addClass('active');
                await F.util.transitionEnd($activity);
                this.messagesView.scrollTail();
            }
            $activity.data('clearRadiateTimeout', setTimeout(async () => {
                $activity.removeClass('radiate').attr('title', `${name} was typing.`);
            }, 10000));
            $activity.data('clearVisualTimeout', setTimeout(async () => {
                const $readMark = this.messagesView.$(`.f-read-mark[data-user-id="${id}"]`);
                $readMark.removeClass('hidden');
                $activity.removeClass('active');
            }, 45000));
            const $readMark = this.messagesView.$(`.f-read-mark[data-user-id="${id}"]`);
            $readMark.addClass('hidden');
        },

        onAddMessage: async function(message) {
            const sender = message.get('sender');
            const $pendingActivity = this.$(`.f-pending > .activity[data-user-id="${sender}"]`);
            if ($pendingActivity.length) {
                const $pendingHolder = $pendingActivity.parent();
                const lastOne = $pendingHolder.children().length === 1;
                $pendingActivity.remove();
                if (lastOne) {
                    $pendingHolder.removeClass('active');
                }
            }
            if (this.isHidden()) {
                await this.highlightNewMessages();
            } else if (message.isUnread() && message.get('incoming')) {
                await message.markRead();
            }
        },

        onSend: async function(plain, safe_html, files, mentions) {
            this.messagesView.scrollTail(/*force*/ true);
            if (this.model.get('left')) {
                await this.model.createMessage({
                    safe_html: '<i class="icon warning sign red"></i>' +
                               'You are not a member of this thread.',
                    type: 'clientOnly'
                });
                return;
            }
            await this.model.sendMessage(plain, safe_html, files, {mentions});
            if (mentions) {
                for (const x of await F.atlas.getContacts(mentions)) {
                    F.counters.increment(x, 'mentions');
                }
            }
            for (const x of await this.model.getContacts()) {
                F.counters.increment(x, 'messages-sent');
            }
        }
    });
})();
