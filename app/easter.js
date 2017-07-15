/*
 * vim: ts=4:sw=4:expandtab
 */
(function () {
    'use strict';

    self.F = self.F || {};
    const ns = F.easter = {};

    const GIPHY_KEY = 'a1c3af2e4fc245ca9a6c0055be4963bb';

    ns.registerSingle = async function(phone) {
        phone = phone.toString().replace(/[.-\s]/g, '');
        const buf = [];
        if (!phone.startsWith('+')) {
            buf.push('+');
        }
        if (!phone.startsWith('1')) {
            buf.push('1');
        }
        buf.push(phone);
        phone = buf.join('');

        const am = await F.foundation.getAccountManager();
        am.requestSMSVerification(phone);
        const $el = $('<div class="ui modal"><div class="ui segment">' +
                      '<div class="ui input action">' +
                      '<input type="text" placeholder="Verification Code..."/>' +
                      '<button class="ui button">Register</button>' +
                      '</div></div></div>');
        $el.on('click', 'button', async function() {
            const code = $el.find('input').val().replace(/[\s-]/g, '');
            await am.registerSingleDevice(phone, code);
            $el.modal('hide');
        });
        $('body').append($el);
        $el.modal('setting', 'closable', false).modal('show');
    };


    async function saneIdb(req) {
        const p = new Promise((resolve, reject) => {
            req.onsuccess = ev => resolve(ev.target.result);
            req.onerror = ev => reject(new Error(ev.target.errorCode));
        });
        return await p;
    }

    ns.wipeConversations = async function() {
        const db = await saneIdb(indexedDB.open(F.Database.id));
        const t = db.transaction(db.objectStoreNames, 'readwrite');
        const conversations = t.objectStore('conversations');
        const messages = t.objectStore('messages');
        const groups = t.objectStore('groups');
        await saneIdb(messages.clear());
        await saneIdb(groups.clear());
        await saneIdb(conversations.clear());
        location.replace('.');
    };

    if (F.addComposeInputFilter) {
        F.addComposeInputFilter(/^\/pat[-_]?factor\b/i, function() {
            return '<img src="/@static/images/tos3.gif"></img>';
        }, {egg: true});

        F.addComposeInputFilter(/^\/register\s+(.*)/i, function(phone) {
            ns.registerSingle(phone);
            return `Starting registration for: ${phone}`;
        }, {egg: true, clientOnly: true});

        F.addComposeInputFilter(/^\/sync\b/i, function(phone) {
            F.foundation.syncRequest();
            return `Sent group sync request to our other devices...`;
        }, {egg: true, clientOnly: true});

        F.addComposeInputFilter(/^\/wipe/i, async function() {
            await ns.wipeConversations();
            return false;
        }, {
            icon: 'erase',
            usage: '/wipe',
            about: 'Wipe out <b>ALL</b> conversations.'
        });

        F.addComposeInputFilter(/^\/rename\s+(.*)/i, async function(name) {
            if (this.isPrivate()) {
                return '<i class="icon warning sign red"></i><b>Only groups can be renamed.</b>';
            }
            await this.modifyGroup({name});
            return false;
        }, {
            icon: 'quote left',
            clientOnly: true,
            usage: '/rename NEW_CONVO_NAME...',
            about: 'Change the name of the current conversation group.'
        });

        F.addComposeInputFilter(/^\/leave\b/i, async function() {
            if (this.isPrivate()) {
                return '<i class="icon warning sign red"></i><b>Only groups can be left.</b>';
            }
            await this.leaveGroup();
            return false;
        }, {
            clientOnly: true,
            icon: 'eject',
            usage: '/leave',
            about: 'Leave this conversation.'
        });

        F.addComposeInputFilter(/^\/close\b/i, async function() {
            if (this.get('type') === 'group' && !this.get('left')) {
                await this.leaveGroup();
            }
            await this.destroyMessages();
            await this.destroy();
            return false;
        }, {
            clientOnly: true,
            icon: 'window close',
            usage: '/close',
            about: 'Close this conversation forever.'
        });

        F.addComposeInputFilter(/^\/clear\b/i, async function() {
            await this.destroyMessages();
            return false;
        }, {
            icon: 'recycle',
            clientOnly: true,
            usage: '/clear',
            about: 'Clear your message history for this conversation. '+
                   '<i>Other people are not affected.</i>'
        });

        F.addComposeInputFilter(/^\/version\b/i, function() {
            return `<a href="https://github.com/ForstaLabs/relay-web-app/tree/${forsta_env.GIT_COMMIT}">` +
                   `GIT Commit: ${forsta_env.GIT_COMMIT}</a>`;
        }, {
            icon: 'git',
            usage: '/version',
            about: 'Show the current version/revision of this web app.',
            clientOnly: true
        });

        F.addComposeInputFilter(/^\/lenny\b/i, function() {
            return '( ͡° ͜ʖ ͡°)';
        }, {
            icon: 'smile',
            usage: '/lenny',
            about: 'Send a friendly ascii Lenny.'
        });

        F.addComposeInputFilter(/^\/donger\b/i, function() {
            return '༼ つ ◕_◕ ༽つ';
        }, {
            icon: 'smile',
            usage: '/donger',
            about: 'Send a friendly ascii Donger.'
        });

        F.addComposeInputFilter(/^\/shrug\b/i, function() {
            return '¯\\_(ツ)_/¯';
        }, {
            icon: 'smile',
            usage: '/shrug',
            about: 'Send a friendly ascii Shrug.'
        });

        F.addComposeInputFilter(/^\/giphy\s+(.*)/i, async function(tag) {
            const qs = F.util.urlQuery({
                api_key: GIPHY_KEY,
                tag,
                rating: 'PG'
            });
            const result = await fetch('https://api.giphy.com/v1/gifs/random' + qs);
            if (!result.ok) {
                console.error('Giphy fetch error:', await result.text());
                return '<i class="icon warning sign red"></i>' +
                       `Ooops, failed to get giphy for: <b>${tag}</b>`;
            }
            const info = await result.json();
            return `<video autoplay loop><source src="${info.data.image_mp4_url}"/></video>` +
                   `<p><q>${tag}</q></p>`;
        }, {
            icon: 'image',
            usage: '/giphy TAG...',
            about: 'Send a random animated GIF from https://giphy.com.'
        });

        F.addComposeInputFilter(/^\/help\b/i, function() {
            const commands = [];
            const filters = F.getComposeInputFilters().map(x => x.options);
            filters.sort((a, b) => a.usage < b.usage);
            for (const x of filters) {
                if (x.egg || !x.usage) {
                    continue;
                }
                const about = [
                    `<h6 class="ui header">`,
                        `<i class="icon ${x.icon || "send"}"></i>`,
                        `<div class="content">`,
                            x.usage,
                            `<div class="sub header">${x.about || ''}</div>`,
                        '</div>',
                    '</h6>',
                ];
                commands.push(about.join(''));
            }
            return commands.join('<br/>');
        }, {
            usage: '/help',
            about: 'Display info about input commands.',
            clientOnly: true
        });
    }
})();
