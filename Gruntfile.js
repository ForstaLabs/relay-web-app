// vim: et sw=2 ts=2
const fs = require('fs');
const path = require('path');


function add_prefix(left, right) {
    const file = path.join(left, right);
    if (!fs.existsSync(file)) {
        throw new Error(`File not found: ${file}`);
    }
    return file;
}


module.exports = function(grunt) {
  'use strict';

  const dist = 'dist';
  const static_dist = `${dist}/static`;

  grunt.loadNpmTasks('grunt-contrib-concat');
  grunt.loadNpmTasks('grunt-contrib-copy');
  grunt.loadNpmTasks('grunt-contrib-sass');
  try {
    grunt.loadNpmTasks('grunt-contrib-watch');
  } catch(e) {
    logger.warn("Grunt 'watch' is not available");
  }

  grunt.initConfig({
    pkg: grunt.file.readJSON('package.json'),

    concat: {
      lib_deps: {
        src: [
          "jquery/dist/jquery.min.js",
          "long/dist/long.min.js",
          "bytebuffer/dist/ByteBufferAB.min.js",
          "protobuf/dist/ProtoBuf.min.js",
          "mustache/mustache.js", // DEPRECATION NOTICE
          "handlebars/handlebars.min.js",
          "underscore/underscore-min.js",
          "backbone/backbone.js",
          "backbone.typeahead.collection/dist/backbone.typeahead.min.js",
          "qrcode/qrcode.min.js",
          "libphonenumber-api/libphonenumber_api-compiled.js",
          "moment/min/moment-with-locales.js",
          "indexeddb-backbonejs-adapter/backbone-indexeddb.js",
          "intl-tel-input/build/js/intlTelInput.min.js",
          "blueimp-md5/js/md5.min.js",
          "emojijs/lib/emoji.min.js",
          "dompurify/dist/purify.min.js",
          "platform.js/platform.js",
          "raven-js/dist/raven.min.js"  // Ensure this is last.
        ].map(x => add_prefix('components', x)),
        dest: `${static_dist}/lib/deps.js`
      },

      lib_textsecure: {
        options: {
          banner: ";(function() {\n",
          footer: "})();\n",
        },
        src: [
          'init.js',
          'errors.js',
          'libsignal-protocol.js',
          'crypto.js',
          'storage.js',
          'storage/user.js',
          'storage/groups.js',
          'protobufs.js',
          'websocket-resources.js',
          'helpers.js',
          'stringview.js',
          'event_target.js',
          'api.js',
          'account_manager.js',
          'message_receiver.js',
          'outgoing_message.js',
          'sendmessage.js',
          'sync_request.js',
          'contacts_parser.js',
          'ProvisioningCipher.js',
        ].map(x => add_prefix('lib/textsecure', x)),
        dest: `${static_dist}/lib/textsecure.js`
      },

      app_main: {
        src: [
          'ga.js',
          'util.js',
          'templates.js',
          'ccsm.js',
          'database.js',
          'storage.js',
          'signal_protocol_store.js',
          'notifications.js',
          'delivery_receipts.js',
          'read_receipts.js',
          'libphonenumber-util.js', // XXX
          'models/ccsm.js',
          'models/messages.js',
          'models/users.js',
          'models/conversations.js',
          'models/blockedNumbers.js', // XXX
          'expiring_messages.js',
          'i18n.js', // XXX
          'conversation_controller.js',
          'panel_controller.js',
          'emoji.js',
          'router.js',
          'views/whisper_view.js', // XXX
          'views/base.js',
          'views/header.js',
          'views/toast_view.js', // XXX
          'views/file_input.js',
          'views/list.js',
          'views/list_view.js', // XXX
          'views/nav.js',
          'views/contact_list_view.js', // XXX
          'views/recipients_input.js',
          'views/new_group_update_view.js', // XXX
          'views/attachment.js',
          'views/key_conflict_dialogue_view.js', // XXX
          'views/error_view.js',
          'views/timestamp_view.js',
          'views/key_verification_view.js', // XXX
          'views/message.js',
          'views/group_member_list_view.js', // XXX
          'views/conversation.js',
          'views/conversation_search.js', // XXX
          'views/compose.js',
          'views/hint_view.js', // XXX
          'views/main.js',
          'views/confirmation_dialog_view.js', // XXX
          'views/identicon_svg_view.js', // XXX
          'views/settings_view.js', // XXX
          'foundation.js',
          'main.js'
        ].map(x => add_prefix('app', x)),
        dest: `${static_dist}/app/main.js`
      },

      app_install: {
        src: [
          'ga.js',
          'ccsm.js',
          'database.js',
          'storage.js',
          'signal_protocol_store.js',
          'libphonenumber-util.js',
          'models/messages.js',
          'models/conversations.js',
          'panel_controller.js',
          'conversation_controller.js',
          'i18n.js',
          'views/whisper_view.js',
          'views/phone-input-view.js',
          'views/install_view.js',
          'foundation.js',
          'install.js'
        ].map(x => add_prefix('app', x)),
        dest: `${static_dist}/app/install.js`
      },

      app_register: {
        src: [
          'ga.js',
          'ccsm.js',
          'database.js',
          'storage.js',
          'signal_protocol_store.js',
          'libphonenumber-util.js',
          'models/messages.js',
          'models/conversations.js',
          'panel_controller.js',
          'conversation_controller.js',
          'i18n.js',
          'views/whisper_view.js',
          'views/phone-input-view.js',
          'views/install_view.js',
          'foundation.js',
          'register.js'
        ].map(x => add_prefix('app', x)),
        dest: `${static_dist}/app/register.js`
      }
    },

    sass: {
      stylesheets: {
        options: {
            sourcemap: 'inline'
        },
        files: [{
          expand: true,
          cwd: 'stylesheets',
          src: ['*.scss'],
          dest: `${static_dist}/stylesheets`,
          ext: '.css'
        }]
      }
    },

    copy: {
      root: {
        nonull: true,
        files: [{
          expand: true,
          src: ['html/**'],
          dest: dist
        }]
      },

      static: {
        nonull: true,
        files: [{
          expand: true,
          src: [
            '_locales/**',
            'protos/**',
            'images/**',
            'fonts/**',
          ],
          dest: static_dist
        }, {
          expand: true,
          cwd: 'components/emoji-data/',
          src: ['img-google-136/**'],
          dest: `${static_dist}/images/emoji`
        }]
      },

      semantic: {
        nonull: true,
        files: [{
          expand: true,
          cwd: 'semantic/dist',
          src: ['**'],
          dest: `${static_dist}/lib/semantic`
        }]
      },
    },

    watch: {
      stylesheets: {
        files: [
          'stylesheets/*.scss',
        ],
        tasks: ['sass']
      },
      code: {
        files: [
          'lib/textsecure/**',
          'app/**',
          'Gruntfile.js'
        ],
        tasks: ['concat', 'copy']
      },
      html: {
        files: [
          'html/**'
        ],
        tasks: ['copy']
      }
    }
  });

  grunt.registerTask('default', ['concat', 'sass', 'copy']);
};
