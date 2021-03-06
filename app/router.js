// vim: ts=4:sw=4:expandtab
/* global Backbone relay moment */

(function() {
    'use strict';

    self.F = self.F || {};
    const ns = F.router = {};

    const logger = F.log.getLogger('router');
    const app_name = 'Forsta';
    const $favicon = $('#favicon');
    const _faviconUrls = {
        normal: F.util.versionedURL(F.urls.static + 'images/favicon.png'),
        unread: F.util.versionedURL(F.urls.static + 'images/favicon-pending.png')
    };
    let _router;
    let title_heading;
    let title_unread = 0;


    function renderTitle(no_unread_count) {
        const parts = [];
        if (!no_unread_count && title_unread > 0) {
            parts.push(`${title_unread} unread |`);
        }
        if (title_heading && title_heading.length) {
            parts.push(title_heading);
        }
        if (parts.length) {
            parts.push('-');
        }
        parts.push(app_name);
        return parts.join(' ');
    }

    function renderFavicon() {
        const category = title_unread ? 'unread' : 'normal';
        $favicon.attr('href', ns.getFaviconURL(category));

        // Electron addition
        if (F.electron) {
            F.electron.updateBadge(title_unread);
        }
    }

    ns.setFaviconURL = function(category, url) {
        _faviconUrls[category] = url;
        renderFavicon();
    };

    ns.getFaviconURL = function(category) {
        return _faviconUrls[category];
    };

    ns.setTitleHeading = function(value) {
        title_heading = value;
        document.title = renderTitle();
    };

    ns.setTitleUnread = function(count) {
        title_unread = count;
        document.title = renderTitle();
        renderFavicon();
    };

    ns.addHistory = function(url, state) {
        const title = renderTitle(/*no_unread_count*/ true);
        _router.navigate(url, {title, state});
    };

    ns.addState = function(state) {
        history.pushState(state, null);
    };

    ns.Router = Backbone.Router.extend({

        routes: {
            "@/conversation/:token": 'onConversation',
            "@/call/:ident": 'onCall',
            "@/:ident": 'onNav',
        },

        onCall: async function(ident) {
            const params = new URLSearchParams(location.search);
            const data = JSON.parse(atob(params.get('data')));
            // Clear the url query before anything else...
            this.navigate(`/@/${ident}`, {replace: true});
            const thread = await this.onNav(ident);
            const callMgr = F.calling.getOrCreateManager(thread.id, thread);
            await callMgr.addPeerJoin(params.get('sender'), params.get('device'), data,
                                      {skipConfirm: true});
        },

        onConversation: async function(token) {
            const params = new URLSearchParams(location.search);
            // Clear the url query before anything else...
            const convo = await F.atlas.getConversation(token);
            let thread = F.foundation.allThreads.get(convo.thread_id);
            if (!thread) {
                thread = await F.foundation.allThreads.make(convo.distribution, {
                    id: convo.thread_id,
                    type: 'conversation'
                });
            }
            this.navigate(`/@/${thread.id}`, {replace: true});
            await thread.sendControl({
                control: 'beacon',
                application: 'web-app',
                url: location.origin + location.pathname,
                userAgent: navigator.userAgent,
                platform: navigator.platform,
                utcOffset: moment().format('Z'),
                language: navigator.language,
                referrer: document.referrer,
                conversationToken: token,
            });
            if (params.has('call')) {
                const callMgr = F.calling.getOrCreateManager(thread.id, thread);
                await callMgr.start({autoJoin: true});
            }
            await F.mainView.openThreadById(thread.id, /*skipHistory*/ true);
        },

        onNav: async function(ident) {
            if (F.util.isUUID(ident)) {
                logger.info("Routing to:", ident);
                return await F.mainView.openThreadById(ident, /*skipHistory*/ true);
            } else if (ident === 'welcome') {
                await F.mainView.openDefaultThread();
            } else {
                const tags = relay.hub.sanitizeTags(ident);
                logger.info("Finding/starting conversation with:", tags);
                const threads = F.foundation.allThreads;
                let thread;
                try {
                    thread = await threads.ensure(tags, {type: 'conversation'});
                } catch(e) {
                    if (e instanceof ReferenceError) {
                        logger.warn("Invalid conversation expression:", tags);
                        await F.mainView.openDefaultThread();
                        return;
                    } else {
                        throw e;
                    }
                }
                return await F.mainView.openThread(thread, /*skipHistory*/ true);
            }
        }
    });

    /* Allow custom title to be used. */
    const history_navigate_super = Backbone.History.prototype.navigate;
    Backbone.History.prototype.navigate = function(fragment, options) {
        if (!this._usePushState) {
            return history_navigate_super.apply(this, arguments);
        }
        if (!Backbone.History.started) {
            return false;
        }
        fragment = this.getFragment(fragment || '');
        let rootPath = this.root;
        if (fragment === '' || fragment.charAt(0) === '?') {
            rootPath = rootPath.slice(0, -1) || '/';
        }
        const url = rootPath + fragment;
        const pathStripper = /#.*$/;
        fragment = this.decodeFragment(fragment.replace(pathStripper, ''));
        if (this.fragment === fragment) {
            return;
        }
        this.fragment = fragment;
        const state = options.state || {};
        const title = options.title || document.title;
        const title_save = document.title;
        document.title = title;  // Unfortunately browsers ignore the title arg currently.
        try {
            this.history[options.replace ? 'replaceState' : 'pushState'](state, title, url);
        } finally {
            document.title = title_save;
        }
        if (options.trigger) {
            return this.loadUrl(fragment);
        }
    };

    ns.start = function(options) {
        _router = new ns.Router();
        addEventListener('popstate', ev => {
            $('.ui.modal').modal('hide');
            if (!ev.state) {
                return;
            }
            if (ev.state.navCollapsed !== undefined) {
                F.mainView.toggleNavBar(ev.state.navCollapsed, /*skipState*/ true);
            }
        });
        $(document).on("click", "a[data-route]", ev => {
            const route = ev.target.dataset.route;
            _router.navigate(route, {trigger: true});
        });
        return Backbone.history.start(Object.assign({pushState: true}, options));
    };
}());
