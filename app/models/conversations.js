// vim: ts=4:sw=4:expandtab

(function () {
    'use strict';

    self.F = self.F || {};

    const userAgent = [
        `ForstaWeb/${F.version}`,
        `(${forsta_env.GIT_COMMIT.substring(0, 10)})`,
        navigator.userAgent
    ].join(' ');

    F.Conversation = Backbone.Model.extend({
        database: F.Database,
        storeName: 'conversations',
        requiredAttrs: new F.util.ESet(['id', 'type', 'recipients', 'users']),

        defaults: function() {
            return {
                unreadCount: 0
            };
        },

        initialize: function() {
            this.messageCollection = new F.MessageCollection([], {
                conversation: this
            });
            this.on('change:avatar', this.updateAvatarUrl);
            this.on('destroy', this.revokeAvatarUrl);
            this.on('read', this.onReadMessage);
            this._messageSender = F.foundation.getMessageSender();
            for (const r of this.get('recipients')) {
                textsecure.store.on('keychange:' + r, () => this.addKeyChange(r));
            }
        },

        addKeyChange: async function(id) {
            const m = this.messageCollection.add({
                conversationId: this.id,
                type: 'keychange',
                sent_at: this.get('timestamp'),
                received_at: this.get('timestamp'),
                key_changed: id
            });
            await m.save();
        },

        onReadMessage: function(message) {
            if (this.messageCollection.get(message.id)) {
                this.messageCollection.get(message.id).fetch();
            }
            return this.getUnread().then(function(unreadMessages) {
                this.save({unreadCount: unreadMessages.length});
            }.bind(this));
        },

        getUnread: async function() {
            const unread = new F.MessageCollection();
            await unread.fetch({
                index: {
                    // 'unread' index
                    name: 'unread',
                    lower: [this.id],
                    upper: [this.id, Number.MAX_VALUE],
                }
            });
            return unread;
        },

        validate: function(attrs) {
            const keys = new F.util.ESet(Object.keys(attrs));
            const missing = this.requiredAttrs.difference(keys);
            if (missing.size) {
                throw new Error("Conversation missing required attributes: " +
                                Array.from(missing).join(', '));
            }
            if (attrs.type !== 'private' && attrs.type !== 'group') {
                throw new TypeError("Invalid type: " + attrs.type);
            }
            if (attrs.type === 'private') {
                if (attrs.users.length !== 1) {
                    throw new Error("Expected a single user entry");
                }
                if (attrs.recipients.length !== 1) {
                    throw new Error("Expected a single recipients entry");
                }
            }
            if (attrs.recipients.length !== attrs.users.length) {
                throw new Error("Users and recipients list are incongruent");
            }
        },

        queueJob: function(callback) {
            var previous = this.pending || Promise.resolve();
            var current = this.pending = previous.then(callback, callback);
            const next = () => {
                if (this.pending === current) {
                    delete this.pending;
                }
            };
            current.then(next, (e) => {
                next();
                throw e;
            });
            return current;
        },

        createBody: function(message) {
            /* Create Forsta msg exchange v1: https://goo.gl/N9ajEX */
            const props = message.attributes;
            const data = {};
            if (props.safe_html && !props.plain) {
                throw new Error("'safe_html' message provided without 'plain' fallback");
            }
            if (props.plain) {
                const body = [{
                    type: 'text/plain',
                    value: props.plain
                }];
                if (props.safe_html && props.safe_html !== props.plain) {
                    body.push({
                        type: 'text/html',
                        value: props.safe_html
                    });
                }
                data.body = body;
            }
            if (props.attachments && props.attachments.length) {
                data.attachments = props.attachments.map(x => ({
                    name: x.name,
                    size: x.size,
                    type: x.type,
                    mtime: x.mtime
                }));
            }
            return [{
                version: 1,
                type: 'ordinary',
                messageId: message.id,
                threadId: this.id,
                threadTitle: this.get('name'),
                userAgent,
                data,
                sendTime: (new Date(props.sent_at)).toISOString(),
            }];
        },

        sendMessage: function(plain, safe_html, attachments) {
            return this.queueJob(async function() {
                const now = Date.now();
                const message = this.messageCollection.add({
                    id: F.util.uuid4(), // XXX Make this a uuid5 hash.
                    plain,
                    safe_html,
                    conversationId: this.id,
                    type: 'outgoing',
                    attachments,
                    sent_at: now,
                    received_at: now,
                    expireTimer: this.get('expireTimer')
                });
                const msg = JSON.stringify(this.createBody(message));
                let to;
                let sender;
                if (this.get('type') === 'private') {
                    console.assert(this.get('recipients').length === 1);
                    to = this.get('recipients')[0];
                    sender = this._messageSender.sendMessageToAddr;
                } else {
                    to = this.id;
                    sender = this._messageSender.sendMessageToGroup;
                }
                await Promise.all([
                    message.save({destination: to}), // prevent getting lost during network failure.
                    this.save({
                        unreadCount: 0,
                        active_at: now,
                        timestamp: now,
                        lastMessage: message.getNotificationText()
                    })
                ]);
                await message.send(sender(to, msg, attachments, now, this.get('expireTimer')));
            }.bind(this));
        },

        updateLastMessage: function() {
            var lastMessage = this.messageCollection.at(this.messageCollection.length - 1);
            if (lastMessage) {
                this.save({
                    lastMessage: lastMessage.getNotificationText(),
                    timestamp: lastMessage.get('sent_at')
                });
            } else {
                this.save({
                    lastMessage: '',
                    timestamp: null
                });
            }
        },

        addExpirationTimerUpdate: async function(expireTimer, source, received_at) {
            received_at = received_at || Date.now();
            this.save({expireTimer});
            const message = this.messageCollection.add({
                conversationId: this.id,
                type: 'outgoing',
                sent_at: received_at,
                received_at,
                flags: textsecure.protobuf.DataMessage.Flags.EXPIRATION_TIMER_UPDATE,
                expirationTimerUpdate: {expireTimer, source}
            });
            await message.save();
            return message;
        },

        sendExpirationTimerUpdate: async function(time) {
            const addr = await F.state.get('addr');
            const message = await this.addExpirationTimerUpdate(time, addr);
            let sendFunc;
            let to;
            if (this.get('type') === 'private') {
                to = this.get('recipients')[0];
                sendFunc = this._messageSender.sendExpirationTimerUpdateToAddr;
            } else {
                to = this.id;
                sendFunc = this._messageSender.sendExpirationTimerUpdateToGroup;
            }
            await message.send(sendFunc(to, this.get('expireTimer'), message.get('sent_at')));
        },

        isSearchable: function() {
            return !this.get('left') || !!this.get('lastMessage');
        },

        endSession: async function() {
            if (this.isPrivate()) {
                const now = Date.now();
                const message = this.messageCollection.add({
                    conversationId: this.id,
                    type: 'outgoing',
                    sent_at: now,
                    received_at: now,
                    flags: textsecure.protobuf.DataMessage.Flags.END_SESSION
                });
                const addr = this.get('recipients')[0];
                await message.save();
                await message.send(this._messageSender.closeSession(addr, now));
            }
        },

        modifyGroup: async function(updates) {
            if (this.isPrivate()) {
                throw new Error("Called update group on private conversation");
            }
            if (updates === undefined) {
                updates = this.pick(['name', 'avatar', 'recipients']);
            } else {
                for (const key of Object.keys(updates)) {
                    this.set(key, updates[key]);
                }
                await this.save();
            }
            const now = Date.now();
            const message = this.messageCollection.add({
                conversationId: this.id,
                type: 'outgoing',
                sent_at: now,
                received_at: now,
                group_update: updates
            });
            await message.save();
            await message.send(this._messageSender.updateGroup(this.id, updates));
        },

        leaveGroup: async function() {
            if (!this.get('type') === 'group') {
                throw new TypeError("Only group conversations can be left");
            }
            const ourAddr = await F.state.get('addr');
            var now = Date.now();
            const message = this.messageCollection.add({
                group_update: {left: [ourAddr]},
                conversationId: this.id,
                type: 'outgoing',
                sent_at: now,
                received_at: now
            });
            await Promise.all([
                this.save({left: true}),
                message.save()
            ]);
            await message.send(this._messageSender.leaveGroup(this.id));
        },

        markRead: async function() {
            if (this.get('unreadCount') > 0) {
                await this.save({unreadCount: 0});
                F.Notifications.remove(F.Notifications.where({conversationId: this.id}));
                const unreadMessages = await this.getUnread();
                const read = unreadMessages.map(m => {
                    if (this.messageCollection.get(m.id)) {
                        // XXX What now?
                        console.warn("XXX doing insane double get nonsense..");
                        m = this.messageCollection.get(m.id);
                    }
                    m.markRead();
                    return {
                        sender: m.get('source'),
                        timestamp: m.get('sent_at')
                    };
                });
                if (read.length > 0) {
                    console.info('Sending', read.length, 'read receipts');
                    await this._messageSender.syncReadMessages(read);
                }
            }
        },

        fetchMessages: function(limit) {
            if (!this.id) {
                return false;
            }
            return this.messageCollection.fetchConversation(this.id, limit);
        },

        destroyMessages: async function() {
            await this.messageCollection.fetch({
                index: {
                    // 'conversation' index on [conversationId, received_at]
                    name  : 'conversation',
                    lower : [this.id],
                    upper : [this.id, Number.MAX_VALUE],
                }
            });
            const models = this.messageCollection.models;
            this.messageCollection.reset([]);
            await Promise.all(models.map(m => m.destroy()));
            await this.save({lastMessage: null});
        },

        isPrivate: function() {
            return this.get('type') === 'private';
        },

        revokeAvatarUrl: function() {
            if (this.avatarUrl) {
                URL.revokeObjectURL(this.avatarUrl);
                this.avatarUrl = null;
            }
        },

        updateAvatarUrl: function(silent) {
            this.revokeAvatarUrl();
            var avatar = this.get('avatar');
            if (avatar) {
                this.avatarUrl = URL.createObjectURL(
                    new Blob([avatar.data], {type: avatar.contentType})
                );
            } else {
                this.avatarUrl = null;
            }
            if (!silent) {
                this.trigger('change');
            }
        },

        getColor: function() {
            const color = this.get('color');
            /* Only accept custom colors that match our palette. */
            if (!color || F.theme_colors.indexOf(color) === -1) {
                if (this.isPrivate()) {
                    return this.getUsers()[0].getColor();
                } else {
                    return F.util.pickColor(this.id);
                }
            }
            return color;
        },

        getAvatar: function() {
            if (!this.avatarUrl) {
                this.updateAvatarUrl(/*silent*/ true);
            }
            if (this.avatarUrl) {
                return {
                    color: this.getColor(),
                    url: this.avatarUrl
                };
            } else if (this.isPrivate()) {
                return this.getUsers()[0].getAvatar();
            } else {
                return {
                    color: this.getColor(),
                    group: this.getUsers().map(u => u.getAvatar()).slice(0, 4)
                };
            }
        },

        getUsers: function() {
            const users = new Set(this.get('users'));
            return F.foundation.getUsers().filter(u => users.has(u.id));
        },

        getNotificationIcon: async function() {
            var avatar = this.getAvatar();
            if (avatar.url) {
                return avatar.url;
            } else if (F.IdenticonSVGView) {
                return await new F.IdenticonSVGView(avatar).getDataUrl();
            }
        },

        resolveConflicts: function(conflict) {
            var addr = conflict.addr;
            var identityKey = conflict.identityKey;
            if (!_.include(this.get('recipients'), addr)) {
                throw new Error('Tried to resolve conflicts for unknown group member');
            }
            if (!this.messageCollection.hasKeyConflicts()) {
                throw new Error('No conflicts to resolve');
            }
            return textsecure.store.removeIdentityKey(addr).then(function() {
                return textsecure.store.saveIdentity(addr, identityKey).then(function() {
                    let promise = Promise.resolve();
                    let conflicts = this.messageCollection.filter(function(message) {
                        return message.hasKeyConflict(addr);
                    });
                    // group incoming & outgoing
                    conflicts = _.groupBy(conflicts, function(m) { return m.get('type'); });
                    // sort each group by date and concatenate outgoing after incoming
                    _.flatten([
                        _.sortBy(conflicts.incoming, function(m) { return m.get('received_at'); }),
                        _.sortBy(conflicts.outgoing, function(m) { return m.get('received_at'); }),
                    ]).forEach(function(message) {
                        var resolveConflict = function() {
                            return message.resolveConflict(addr);
                        };
                        promise = promise.then(resolveConflict, resolveConflict);
                    });
                    return promise;
                }.bind(this));
            }.bind(this));
        },

        notify: function(message) {
            if (!message.isIncoming()) {
                return;
            }
            /* Just notify if we are a service worker (ie. !document) */
            if (self.document && !document.hidden) {
                return;
            }
            var sender = this.collection.add({
                id: message.get('source'),
                type: 'private'
            }, {merge: true});
            var conversationId = this.id;
            sender.fetch().then(function() {
                sender.getNotificationIcon().then(function(iconUrl) {
                    F.Notifications.add({
                        title: sender.getTitle(),
                        message: message.getNotificationText(),
                        iconUrl: iconUrl,
                        imageUrl: message.getImageUrl(),
                        conversationId,
                        messageId: message.id
                    });
                });
            });
        }
    });

    F.ConversationCollection = Backbone.Collection.extend({
        database: F.Database,
        storeName: 'conversations',
        model: F.Conversation,

        comparator: function(m) {
            return -m.get('timestamp');
        },

        destroyAll: async function () {
            await Promise.all(this.models.map(m => m.destroy()));
        },

        search: async function(query) {
            query = query.trim().toLowerCase();
            if (query.length > 0) {
                query = query.replace(/[-.()]*/g,'').replace(/^\+(\d*)$/, '$1');
                var lastCharCode = query.charCodeAt(query.length - 1);
                var nextChar = String.fromCharCode(lastCharCode + 1);
                var upper = query.slice(0, -1) + nextChar;
                try {
                    this.fetch({
                        index: {
                            name: 'search', // 'search' index on tokens array
                            lower: query,
                            upper: upper,
                            excludeUpper: true
                        }
                    });
                } catch(e) {
                    if (e.message !== 'Not Found') {
                        throw e;
                    }
                    return false;
                }
                return true;
            } else {
                return false;
            }
        },

        fetchAlphabetical: async function() {
            try {
                await this.fetch({
                    index: {
                        name: 'search', // 'search' index on tokens array
                    },
                    limit: 100
                });
            } catch(e) {
                if (e.message !== 'Not Found') {
                    throw e;
                }
                return false;
            }
            return true;
        },

        fetchGroups: async function(addr) {
            try {
                await this.fetch({
                    index: {
                        name: 'group',
                        only: addr
                    }
                });
            } catch(e) {
                if (e.message !== 'Not Found') {
                    throw e;
                }
                return false;
            }
            return true;
        },

        fetchActive: function() {
            // Ensures all active conversations are included in this collection,
            // and updates their attributes, but removes nothing.
            return this.fetch({
                index: {
                    name: 'inbox', // 'inbox' index on active_at
                    order: 'desc'  // ORDER timestamp DESC
                    // TODO pagination/infinite scroll
                    // limit: 10, offset: page*10,
                },
                remove: false
            });
        },

        _lazyget: async function(id) {
            let convo = this.get(id);
            if (!convo) {
                convo = new F.Conversation(id);
                try {
                    await convo.fetch();
                } catch(e) {
                    if (e.message !== 'Not Found') {
                        throw e;
                    }
                    convo = undefined;
                }
            }
            return convo;
        },

        findOrCreate: async function(message) {
            if (message.get('conversationId')) {
                const convo = this._lazyget(message.get('conversationId'));
                if (convo) {
                    return convo;
                }
            }
            console.warn("Creating new conversation without good data.");
            return await this.make({recipients: [message.get('source')]});
        },

        make: async function(attrs, options) {
            const isNew = !attrs.id;
            if (isNew) {
                attrs.id = F.util.uuid4();
                console.info("Creating new conversation:", attrs.id);
            }
            attrs.active_at = Date.now();
            attrs.timestamp = attrs.active_at;
            attrs.unreadCount = 0;
            if (attrs.recipients) {
                /* Ensure our addr is not in the recipients. */
                const addrs = new Set(attrs.recipients);
                addrs.delete(await F.state.get('addr'));
                attrs.recipients = Array.from(addrs);
            }
            if (attrs.users) {
                /* Ensure our user is not in the recipients. */
                const users = new Set(attrs.users);
                users.delete((await F.ccsm.getUserProfile()).id);
                attrs.users = Array.from(users);
            }
            if (!attrs.recipients && !attrs.users) {
                throw new Error("Required props missing: users or recipients must be provided");
            }
            if (!attrs.recipients) {
                const users = F.foundation.getUsers();
                // XXX maybe we want ccsm to store the signal address aside the phone.
                attrs.recipients = attrs.users.map(x => users.get(x).get('phone'));
                if (attrs.recipients.indexOf(undefined) !== -1) {
                    throw new Error('Invalid user detected');
                }
            } else if (!attrs.users) {
                const users = F.foundation.getUsers();
                // XXX maybe we want ccsm to store the signal address aside the phone.
                attrs.users = attrs.recipients.map(x => users.findWhere({phone: x}).id);
                if (attrs.users.indexOf(undefined) !== -1) {
                    throw new Error('Invalid signal address detected');
                }
            }
            if (!attrs.type) {
                attrs.type = attrs.users.length > 1 ? 'group' : 'private';
            }
            if (attrs.type === 'group' && isNew) {
                const ms = F.foundation.getMessageSender();
                console.info("Creating group for:", attrs.id);
                await ms.startGroup(attrs.id, attrs.recipients, attrs.name);
            }
            const c = this.add(attrs, options);
            await c.save();
            return c;
        }
    });

    F.InboxCollection = Backbone.Collection.extend({
        initialize: function() {
            this.on('change:timestamp change:name change:addr', this.sort);
        },

        comparator: function(m1, m2) {
            var timestamp1 = m1.get('timestamp');
            var timestamp2 = m2.get('timestamp');
            if (timestamp1 && timestamp2) {
                return timestamp2 - timestamp1;
            }
            if (timestamp1) {
                return -1;
            }
            if (timestamp2) {
                return 1;
            }
            var title1 = m1.get('name');
            var title2 = m2.get('name');
            if (title1 ===  title2) {
                return 0;
            }
            if (title1 < title2) {
                return -1;
            }
            if (title1 > title2) {
                return 1;
            }
        },

        addActive: function(model) {
            if (model.get('active_at')) {
                this.add(model);
            } else {
                this.remove(model);
            }
        }
    });
})();
