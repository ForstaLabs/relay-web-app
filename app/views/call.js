// vim: ts=4:sw=4:expandtab

(function () {
    'use strict';

    self.F = self.F || {};

    F.CallView = F.ModalView.extend({
        template: 'views/call.html',
        className: 'f-call ui modal',

        initialize: function(options) {
            this.offer = options.offer;
            this.on('icecandidate', this.onICECandidate);
            this.on('answer', this.onAnswer);
            F.ModalView.prototype.initialize(options);
        },

        events: {
            'click .f-call.button': 'onCallClick',
            'click .f-hangup.button': 'hangup',
            'click .f-retry.button': 'render',
        },

        render_attributes: function() {
            return {
                thread: this.model,
                error: this.error
            };
        },

        render: async function() {
            this.error = undefined;
            try {
                this.stream = await navigator.mediaDevices.getUserMedia({audio: true, video: true});
            } catch(e) {
                this.error = e.message;
            }
            await F.View.prototype.render.call(this);
            if (!this.error) {
                this.$('.f-video.local')[0].srcObject = this.stream;
            }
            if (this.offer) {
                await this.onOffer(this.offer);
            }
            return this;
        },

        hangup: function() {
            if (this.peer) {
                this.peer.close();
                this.peer = null;
            }
            if (this.stream) {
                for (const track of this.stream.getTracks()) {
                    track.stop();
                }
                this.stream = null;
            }
            this.$('.f-call.button').removeAttr('disabled');
            this.$('.f-hangup.button').attr('disabled', 'disabled');
        },

        makePeerConnection: async function() {
            const iceServers = await F.atlas.getRTCServersFromCache();
            const peer = new RTCPeerConnection({iceServers});
            peer.addStream(this.stream);
            peer.addEventListener('icecandidate', async ev => {
                if (!ev.candidate) {
                    console.warn("Dropping malformed ICE Candidate:", ev);
                    return;
                }
                await this.model.sendControl({
                    control: 'callICECandidate',
                    icecandidate: ev.candidate
                }, null, {excludeSelf: true});
            });
            peer.addEventListener('addstream', ev => {
                console.info("Add remote stream:", ev.stream);
                this.$('.f-video.remote')[0].srcObject = ev.stream;
            });
            peer.addEventListener('removestream', ev => {
                debugger;
                console.error("OFFER XXX", ev);
            });
            return peer;
        },

        onHide: function() {
            this.hangup();
            F.ModalView.prototype.onHide.apply(this, arguments);
        },

        onCallClick: async function(ev) {
            this.$('.f-call.button').attr('disabled', 'disabled');
            this.$('.f-hangup.button').removeAttr('disabled');
            this.peer = await this.makePeerConnection();
            const offer = await this.peer.createOffer();
            await this.peer.setLocalDescription(offer);
            // XXX Can this offer be used by multiple clients?  Multi client is unvetted.
            await this.model.sendControl({control: 'callOffer', offer}, null,
                                         {excludeSelf: true});
        },

        onOffer: async function(offer) {
            this.$('.f-call.button').attr('disabled', 'disabled');
            this.$('.f-hangup.button').removeAttr('disabled');
            this.peer = await this.makePeerConnection();
            await this.peer.setRemoteDescription(new RTCSessionDescription(offer));
            const answer = await this.peer.createAnswer();
            await this.peer.setLocalDescription(answer);
            // XXX Probably need to send ONLY to the user that requested this.
            await this.model.sendControl({control: 'callAnswer', answer}, null,
                                         {excludeSelf: true});
        },

        onAnswer: async function(answer) {
            await this.peer.setRemoteDescription(new RTCSessionDescription(answer));
        },

        onICECandidate: async function(candidate) {
            await this.peer.addIceCandidate(new RTCIceCandidate(candidate));
        }
    });
})();