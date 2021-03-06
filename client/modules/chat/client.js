define(['jquery','underscore','backbone','client','regex','ui/Faviconizer','CryptoWrapper',
		'modules/chat/Autocomplete',
		'modules/chat/Scrollback',
		'modules/chat/Log',
		'modules/chat/ChatLog',
		'ui/Mewl',
		'text!modules/chat/templates/chatPanel.html',
		'text!modules/chat/templates/chatInput.html',
		'text!modules/chat/templates/channelCryptokeyModal.html',
		'text!modules/chat/templates/fileUpload.html'
	],

	function($, _, Backbone,
		Client, Regex, faviconizer, crypto, Autocomplete, Scrollback, Log, ChatLog, Mewl,
		chatpanelTemplate, chatinputTemplate, cryptoModalTemplate, fileUploadTemplate) {

	function readablizeBytes (bytes) {
	    var s = ['bytes', 'kB', 'MB', 'GB', 'TB', 'PB'];
	    var e = Math.floor(Math.log(bytes) / Math.log(1024));
	    return (bytes / Math.pow(1024, e)).toFixed(2) + " " + s[e];
	}

	var ColorModel = Client.ColorModel,
		ClientModel = Client.ClientModel,
		ClientsCollection = Client.ClientsCollection,
		REGEXES = Regex.REGEXES;

	return Backbone.View.extend({
		className: "chatChannel",
		template: _.template(chatpanelTemplate),
		inputTemplate: _.template(chatinputTemplate),
		fileUploadTemplate: _.template(fileUploadTemplate),

		cryptoModal: Backbone.View.extend({

			className: "backdrop",

			template: _.template(cryptoModalTemplate),

			events: {
				"keydown input.crypto-key": "checkToSetKey",
				"click .set-encryption-key": "setCryptoKey",
				"click .cancel": "remove"
			},

			initialize: function (opts) {
				_.bindAll(this);
				_.extend(this, opts);

				this.$el.html(this.template(opts));

				$("body").append(this.$el);

				$("input", this.$el).focus();
			},

			checkToSetKey: function (e) {
				if (e.keyCode === 13) {
					this.setKey($(".crypto-key", this.$el).val());
				}
			},

			setCryptoKey: function (e) {
				this.setKey($(".crypto-key", this.$el).val());
			},

			setKey: function (key) {
				this.trigger("setKey", {
					key: key
				});
				this.remove();
			}
		}),

		chatMessage: Backbone.Model.extend({
			getBody: function (cryptoKey) {
				var body = this.get("body"),
					encrypted_body = this.get("encrypted");

				if ((typeof cryptoKey !== "undefined") &&
					(cryptoKey !== "") &&
					(typeof encrypted_body !== "undefined")) {
					body = crypto.decryptObject(encrypted_body, cryptoKey);
				}

				return body;
			}
		}),

		initialize: function (opts) {
			var self = this;

			_.bindAll(this);

			this.hidden = true;
			this.config = opts.config;
            this.module = opts.module;
			this.socket = io.connect(this.config.host + "/chat");
			this.channel = opts.channel;
			this.channel.clients.model = ClientModel;

			this.channelName = opts.room;
			this.autocomplete = new Autocomplete();
			this.scrollback = new Scrollback();
			this.persistentLog = new Log({
				namespace: this.channelName
			});

			this.me = new ClientModel({
				socket: this.socket
			});
			this.me.peers = this.channel.clients; // let the client have access to all the users in the channel

			this.chatLog = new ChatLog({
				room: this.channelName,
				persistentLog: this.persistentLog,
				me: this.me
			});

			this.me.cryptokey = window.localStorage.getItem("chat:cryptokey:" + this.channelName);
			if (this.me.cryptokey === "") {
				delete this.me.cryptokey;
			}

			this.me.persistentLog = this.persistentLog;

			this.listen();
			this.render();
			this.attachEvents();
			this.bindReconnections(); // Sets up the client for Disconnect messages and Reconnect messages

			// initialize the channel
			this.socket.emit("subscribe", {
				room: self.channelName
			}, this.postSubscribe);

			// if there's something in the persistent chatlog, render it:
			if (!this.persistentLog.empty()) {
				var entries = this.persistentLog.all();
				var renderedEntries = [];
				for (var i = 0, l = entries.length; i < l; i++) {
					var model = new this.chatMessage(entries[i]),
						entry = this.chatLog.renderChatMessage(model, {
							delayInsert: true
						});

					renderedEntries.push(entry);
				}
				this.chatLog.insertBatch(renderedEntries);
			}

			// triggered by ChannelSwitcher:
			this.on("show", this.show);
			this.on("hide", this.hide);

			this.channel.clients.on("change:nick", function (model,changedAttributes) {
				var prevName,
					currentName = model.getNick(self.me.cryptokey);

				if (self.me.is(model)) {
					prevName = "You are"
				} else {
					var prevClient = new ClientModel(model.previousAttributes())
					prevName = prevClient.getNick(self.me.cryptokey);
					prevName += " is";
				}

				self.chatLog.renderChatMessage(new self.chatMessage({
					body: prevName + " now known as " + currentName,
					type: 'SYSTEM',
					timestamp: new Date().getTime(),
					nickname: '',
					class: 'identity ack'
				}));
			});


			this.channel.clients.on("add", function (model) {
				self.chatLog.renderChatMessage(new self.chatMessage({
					body: model.getNick(self.me.cryptokey) + " has joined the room.",
					type: 'SYSTEM',
					timestamp: new Date().getTime(),
					nickname: '',
					class: 'join'
				}));
			});

			this.channel.clients.on("remove", function (model) {
				self.chatLog.renderChatMessage(new self.chatMessage({
					body: model.getNick(self.me.cryptokey) + " has left the room.",
					type: 'SYSTEM',
					timestamp: new Date().getTime(),
					nickname: '',
					class: 'part'
				}));
			});

			this.channel.clients.on("add remove reset change", function (model) {
				self.chatLog.renderUserlist(self.channel.clients);

				self.autocomplete.setPool(_.map(self.channel.clients.models, function (user) {
					return user.getNick(self.me.cryptokey);
				}));
			});


			// doesn't work when defined as a backbone event :(
			this.scrollSyncLogs = _.throttle(this._scrollSyncLogs, 500); // so we don't sync too quickly
			$(".messages", this.$el).on("mousewheel DOMMouseScroll", this.scrollSyncLogs);

		},

		events: {
			"click button.syncLogs": "activelySyncLogs",
			"click button.deleteLocalStorage": "deleteLocalStorage",
			"click button.deleteLocalStorageAndQuit": "logOut",
			"click button.clearChatlog": "clearChatlog",
			"click .icon-reply": "reply",
			"keydown .chatinput textarea": "handleChatInputKeydown",
			"click button.not-encrypted": "showCryptoModal",
			"click button.encrypted": "clearCryptoKey",

			"dragover .linklog": "showDragUIHelper",
			"dragleave .drag-mask": "hideDragUIHelper",
			"drop .drag-mask": "dropObject",
			"click .cancel-upload": "clearUploadStaging",
			"click .upload": "uploadFile"
		},

		_scrollSyncLogs: function (ev) {
			// make a note of how tall in scrollable px the messages area used to be
			this.previousScrollHeight = ev.currentTarget.scrollHeight;
			
			// let the chatlog know that we've been scrolling (s.t. it doesn't autoscroll back down on us)
			this.chatLog.mostRecentScroll = Number(new Date());

			// load more messages as we scroll upwards
			if (ev.currentTarget.scrollTop === 0 && 
				!this.scrollSyncLocked) {

				this.activelySyncLogs();
			}
		},

		showDragUIHelper: function (ev) {
			this.noop(ev);
			$(".linklog", this.$el).addClass("drag-into");
			$(".drag-mask, .drag-staging", this.$el).show();
		},

		hideDragUIHelper: function (ev) {
			this.noop(ev);
			$(".linklog", this.$el).removeClass("drag-into");
			$(".drag-mask, .drag-staging", this.$el).hide();
		},

		noop: function (ev) {
			ev.stopPropagation();
			ev.preventDefault();
			// return false;
		},

		dropObject: function (ev) {
			var self = this;

			this.noop(ev);
			console.log(ev.originalEvent.dataTransfer); // will report .files.length => 0 (it's just a console bug though!)
			console.log(ev.originalEvent.dataTransfer.files[0]);  // it actually exists :o

			var file = ev.originalEvent.dataTransfer.files[0];

			if (typeof file === "undefined" ||
				file === null) {

				this.clearUploadStaging();
				return;
			}

			this.file = file;

			var reader = new FileReader();
			reader.addEventListener("loadend", function (e) {

				var data = {
					fileName: self.file.name,
					fileSize: readablizeBytes(self.file.size),
					img: null
				};

				if (e.target.result.match(/^data:image/)) { // show img preview
					data.img = e.target.result
              	}

				$(".staging-area", this.$el).html(self.fileUploadTemplate(data));

			}, false);
            reader.readAsDataURL(file);

            $(".drag-mask", this.$el).hide();
		},

		clearUploadStaging: function () {
			$(".drag-staging, .drag-mask", this.$el).hide();
			$(".staging-area", this.$el).html("");
			delete this.file;
		},

		uploadFile: function () {
			var self = this,
				$progressBarContainer = $(".progress-bar", this.$el),
				$progressMeter = $(".meter", this.$el);

			// construct a new form to send the data via
			var oForm = new FormData();
			// add the file to the form
			oForm.append("user_upload", this.file);
			// create a new XHR request
			var oReq = new XMLHttpRequest();

			// is it uploads, increase the width of the progress bar
			oReq.upload.addEventListener("progress", function (ev) {
				var percentage = (ev.loaded / ev.total) * 100;
				$progressMeter.css("width", percentage + "%"); // namespace
			}, false);

			// when it's done, hide the progress bar
			oReq.upload.addEventListener("load", function (ev) {
				$progressBarContainer.removeClass("active");
			});

			oReq.open("POST", window.location.origin);
			oReq.setRequestHeader('Using-Permission', "canUploadFile");
			oReq.setRequestHeader('Channel', this.channelName);
			oReq.setRequestHeader('From-User', this.me.get("id"));
			oReq.setRequestHeader('Antiforgery-Token', this.me.antiforgery_token);
			oReq.send(oForm); // send it

			// show the progress bar
			$progressBarContainer.addClass("active");

			this.clearUploadStaging();

			return false;
		},

		show: function(){
			this.$el.show();
			this.chatLog.scrollToLatest();
			$("textarea", self.$el).focus();
			this.hidden = false;
		},

		hide: function () {
			this.$el.hide();
			this.hidden = true;
		},

		bindReconnections: function(){
			var self = this;
			//Bind the disconnnections, send message on disconnect
			self.socket.on("disconnect",function(){
				self.chatLog.renderChatMessage(new self.chatMessage({
					body: 'Disconnected from the server',
					type: 'SYSTEM',
					timestamp: new Date().getTime(),
					nickname: '',
					class: 'client'
				}));

				window.disconnected = true;
				faviconizer.setDisconnected();

			});
			//On reconnection attempts, print out the retries
			self.socket.on("reconnecting",function(nextRetry){
				self.chatLog.renderChatMessage(new self.chatMessage({
					body: 'Connection lost, retrying in ' + nextRetry/1000.0 + ' seconds',
					type: 'SYSTEM',
					timestamp: new Date().getTime(),
					nickname: '',
					class: 'client'
				}));
			});
			//On successful reconnection, render the chatmessage, and emit a subscribe event
			self.socket.on("reconnect",function(){
				//Resend the subscribe event
				self.socket.emit("subscribe", {
					room: self.channelName,
					reconnect: true
				}, function () { // server acks and we:
					// if we were idle on reconnect, report idle immediately after ack
					if (self.me.get('idle')){
						self.me.inactive("", self.channelName, self.socket);
					}
					self.postSubscribe();
				});
			});
		},

		kill: function () {
			var self = this;

			this.socket.emit("unsubscribe:" + this.channelName);
			_.each(this.socketEvents, function (method, key) {
				self.socket.removeAllListeners(key + ":" + self.channelName);
			});
		},

		postSubscribe: function (data) {
			var self = this;
			
			this.chatLog.renderChatMessage(new self.chatMessage({
				body: 'Connected. Now talking in channel ' + this.channelName,
				type: 'SYSTEM',
				timestamp: new Date().getTime(),
				nickname: '',
				class: 'client'
			}));

			// attempt to automatically /nick and /ident
			$.when(this.autoNick()).done(function () {
				self.autoIdent();
			});

			// start the countdown for idle
			this.startIdleTimer();

			window.disconnected = false;
			faviconizer.setConnected();
		},

		autoNick: function () {
			var acked = $.Deferred();
			var storedNick = $.cookie("nickname:" + this.channelName);
			if (storedNick) {
				this.me.setNick(storedNick, this.channelName, acked);
			} else {
				acked.reject();
			}

			return acked.promise();
		},

		autoIdent: function () {
			var acked = $.Deferred();
			var storedIdent = $.cookie("ident_pw:" + this.channelName);
			if (storedIdent) {
				this.me.identify(storedIdent, this.channelName, acked);
			} else {
				acked.reject();
			}
			return acked.promise();
		},

		autoAuth: function () {
			// we only care about the success of this event, but the server already responds
			// explicitly with a success event if it is so
			var storedAuth = $.cookie("channel_pw:" + this.channelName);
			if (storedAuth) {
				this.me.channelAuth(storedAuth, this.channelName);
			}
		},

		render: function () {
			this.$el.html(this.template());
			$(".chatarea", this.$el).html(this.chatLog.$el);
			this.$el.attr("data-channel", this.channelName);

			this.$el.append(this.inputTemplate({
				encrypted: (typeof this.me.cryptokey !== "undefined" && this.me.cryptokey !== null)
			}));
		},

		checkToNotify: function (msg) {
			// scan through the message and determine if we need to notify somebody that was mentioned:

			var msgBody = msg.getBody(this.me.cryptokey),
				myNick = this.me.getNick(this.me.cryptokey),
				msgClass = msg.get("class"),
				fromNick = msg.get("nickname"),
				atMyNick = "@" + myNick,
				encrypted_nick = msg.get("encrypted_nick");

			if (encrypted_nick) {
				fromNick = crypto.decryptObject(encrypted_nick, this.me.cryptokey);
			}

			// check to see if me.nick is contained in the msgme.
			if ((msgBody.toLowerCase().indexOf(atMyNick.toLowerCase()) !== -1) ||
				(msgBody.toLowerCase().indexOf("@all") !== -1)) {

				// do not alter the message in the following circumstances:
				if (msgClass) {
					if ((msgClass.indexOf("part") !== -1) ||
						(msgClass.indexOf("join") !== -1)) { // don't notify for join/part; it's annoying when anonymous

						return msg; // short circuit
					}
				}

				if (this.channel.isPrivate || msgClass === "private") {
					// display more privacy-minded notifications for private channels
					notifications.notify({
						title: "echoplexus",
						body: "There are new unread messages",
						tag: "chatMessage"
					});
				} else {
					// display a full notification
					notifications.notify({
						title: fromNick + " says:",
						body: msgBody,
						tag: "chatMessage"
					});
				}
				msg.set("directedAtMe", true); // alter the message
			}
			
			if (msg.get("type") !== "SYSTEM") { // count non-system messages as chat activity
				window.events.trigger("chat:activity", {
					channelName: this.channelName
				});

				// do not show a growl for this channel's chat if we're looking at it
				if (OPTIONS.show_mewl &&
					(this.hidden || !chatModeActive())) {

					var growl = new Mewl({
						title: this.channelName + ":  " + fromNick,
						body: msgBody
					});
				}
			}

			return msg;
		},

		listen: function () {
			var self = this,
				socket = this.socket;

			this.socketEvents = {
				"chat": function (msg) {
					window.events.trigger("message",socket,self,msg);

					var message = new self.chatMessage(msg);

					// update our scrollback buffer so that we can quickly edit the message by pressing up/down
					// https://github.com/qq99/echoplexus/issues/113 "Local scrollback should be considered an implicit edit operation"
					if (message.get("you") === true) {
						self.scrollback.replace(
							message.getBody(self.me.cryptokey),
							"/edit #" + message.get("mID") + " " + message.getBody(self.me.cryptokey)
						);
					}

					self.checkToNotify(message);
					self.persistentLog.add(message.toJSON());
					self.chatLog.renderChatMessage(message);
				},
				"chat:batch": function (msgs) {
					var msg;
					for (var i = 0, l = msgs.length; i < l; i++) {
						msg = JSON.parse(msgs[i]);

						self.persistentLog.add(msg);

						msg.fromBatch = true;
						self.chatLog.renderChatMessage(new self.chatMessage(msg));

						if (self.previousScrollHeight) {
							setTimeout(function () {
								var chatlog = self.chatLog.$el.find(".messages")[0];
								chatlog.scrollTop = chatlog.scrollHeight - self.previousScrollHeight;
							}, 0);

						}
					}
					self.scrollSyncLocked = false; // unlock the lock on scrolling to sync logs
				},
				"client:changed": function (alteredClient) {
					var prevClient = self.channel.clients.findWhere({
						id: alteredClient.id
					});

					if (alteredClient.color) {
						alteredClient.color = new ColorModel(alteredClient.color);
					}
					if (prevClient) {
						prevClient.set(alteredClient);
						if (typeof alteredClient.encrypted_nick === "undefined") {
							prevClient.unset("encrypted_nick");
						} // backbone won't unset undefined

						// check to see if it's ME that's being updated
						// TODO: this is hacky, but it fixes notification nick checking :s
						if (prevClient.get("id") === self.me.get("id")) {
							self.me.set(alteredClient);
							if (typeof alteredClient.encrypted_nick === "undefined") {
								self.me.unset("encrypted_nick");
							} // backbone won't unset undefined
						}
					} else { // there was no previous client by this id
						self.channel.clients.add(alteredClient);
					}
				},
				"client:removed": function (alteredClient) {
					console.log("client left", alteredClient);
					var prevClient = self.channel.clients.remove({
						id: alteredClient.id
					});
				},
				"private_message": function (msg) {

					var message = new self.chatMessage(msg);

					msg = self.checkToNotify(message);

					self.persistentLog.add(message.toJSON());
					self.chatLog.renderChatMessage(message);
				},
				"private": function () {
					self.channel.isPrivate = true;
					self.autoAuth();
				},
				"webshot": function (msg) {
					self.chatLog.renderWebshot(msg);
				},
				"subscribed": function () {
					self.postSubscribe();
				},
				"chat:edit": function (msg) {
					var message = new self.chatMessage(msg);

					msg = self.checkToNotify(message); // the edit might have been to add a "@nickname", so check again to notify

					self.persistentLog.replaceMessage(message.toJSON()); // replace the message with the edited version in local storage
					self.chatLog.replaceChatMessage(message); // replace the message with the edited version in the chat log
				},
				"client:id": function (msg) {
					self.me.set("id", msg.id);
				},
				"userlist": function (msg) {
					// update the pool of possible autocompletes
					self.channel.clients.reset(msg.users);
				},
				"chat:currentID": function (msg) {
					var missed;
					
					self.persistentLog.latestIs(msg.mID); // store the server's current sequence number

					// find out only what we missed since we were last connected to this channel
					missed = self.persistentLog.getListOfMissedMessages();

					// then pull it, if there was anything
					if (missed && missed.length) {
						socket.emit("chat:history_request:" + self.channelName, {
							requestRange: missed
						});
					}
				},
				"topic": function (msg) {
					var topic;
					if (msg.body === null) return;
					// attempt to parse the msg.body as a JSON object
					try { // if it succeeds, it was an encrypted object
						var encrypted_topic = JSON.parse(msg.body);
						if (self.me.cryptokey) {
							topic = crypto.decryptObject(encrypted_topic, self.me.cryptokey);
						} else {
							topic = encrypted_topic.ct;
						}
					} catch (e) {
						// console.log(e);
						topic = msg.body;
					}
					self.chatLog.setTopic(topic);
				},
				"antiforgery_token": function (msg) {
					if (msg.antiforgery_token) {
						self.me.antiforgery_token = msg.antiforgery_token;
					}
				},
				"file_uploaded": function (msg) {
					var fromClient = self.channel.clients.findWhere({id: msg.from_user});

					if (typeof fromClient === "undefined" ||
						fromClient === null) {

						return;
					}

					var nick;
					if (self.me.is(fromClient)) {
						nick = "You";
					} else {
						nick = fromClient.getNick(self.me.cryptokey);
					}

					var chatMessage = new self.chatMessage({
						body: nick + " uploaded a file: " + msg.path,
						timestamp: new Date().getTime(),
						nickname: ''
					});

					self.chatLog.renderChatMessage(chatMessage);
					self.persistentLog.add(chatMessage.toJSON());
				}
			};

			_.each(this.socketEvents, function (value, key) {
				// listen to a subset of event
				socket.on(key + ":" + self.channelName, value);
			});
		},
		attachEvents: function () {
			var self = this;

			window.events.on("chat:broadcast", function (data) {
				self.me.speak({
					body: data.body,
					room: self.channelName
				}, self.socket);
			});

			window.events.on("unidle", function () {
				if (self.$el.is(":visible")) {
					if (self.me) {
						self.me.active(self.channelName, self.socket);
						clearTimeout(self.idleTimer);
						self.startIdleTimer();						
					}
				}
			});

			window.events.on("beginEdit:" + this.channelName, function (data) {
				var mID = data.mID,
					msgText,
					msg = self.persistentLog.getMessage(mID); // get the raw message data from our log, if possible

				if (!msg) { // if we didn't have it in our log (e.g., recently cleared storage), then get it from the DOM
					msgText = $(".chatMessage.mine[data-sequence='" + mID + "'] .body").text();
				} else {
					msgText = msg.body;
				}
				$(".chatinput textarea", this.$el).val("/edit #" + mID + " " + msg.body).focus();
			});

			window.events.on("edit:commit:" + this.channelName, function (data) {
				self.socket.emit('chat:edit:' + self.channelName, {
					mID: data.mID,
					body: data.newText
				});
			});

			// let the chat server know our call status so we can advertise that to other users
			window.events.on("in_call:" + this.channelName, function (data) {
				self.socket.emit('in_call:' + self.channelName);
			});
			window.events.on("left_call:" + this.channelName, function (data) {
				self.socket.emit('left_call:' + self.channelName);
			});
		},

		handleChatInputKeydown: function (ev) {
			if (ev.ctrlKey || ev.shiftKey) return; // we don't fire any events when these keys are pressed

			var $this = $(ev.target);
			switch (ev.keyCode) {
				// enter:
				case 13:
					ev.preventDefault();
					var userInput = $this.val();
					this.scrollback.add(userInput);

					if (userInput.match(REGEXES.commands.join)) { // /join [channel_name]
						channelName = userInput.replace(REGEXES.commands.join, "").trim();
						window.events.trigger('joinChannel', channelName);
					} else {
						this.me.speak({
							body: userInput,
							room: this.channelName
						}, this.socket);
					}

					$this.val("");
					this.scrollback.reset();
					break;
				// up:
				case 38:
					$this.val(this.scrollback.prev());
					break;
				// down
				case 40:
					$this.val(this.scrollback.next());
					break;
				// escape
				case 27:
					this.scrollback.reset();
					$this.val("");
					break;
				 // tab key
				case 9:
					ev.preventDefault();
					var flattext = $this.val();

					// don't continue to append auto-complete results on the end
					if (flattext.length >= 1 &&
						flattext[flattext.length-1] === " ") {

						return;
					}

					var text = flattext.split(" ");
					var stub = text[text.length - 1];
					var completion = this.autocomplete.next(stub);

					if (completion !== "") {
						text[text.length - 1] = completion;
					}
					if (text.length === 1) {
						text[0] = text[0];
					}

					$this.val(text.join(" "));
					break;
			}
		},

		activelySyncLogs: function (ev) {
			var missed = this.persistentLog.getMissingIDs(25);
			if (missed && missed.length) {
				this.scrollSyncLocked = true; // lock it until we receive the batch of logs
				this.socket.emit("chat:history_request:" + this.channelName, {
					requestRange: missed
				});
			}
		},

		reply: function (ev) {
			ev.preventDefault();

			var $this = $(ev.currentTarget),
				mID = $this.parents(".chatMessage").data("sequence"),
				$textarea = $(".chatinput textarea", this.$el),
				curVal;

			curVal = $textarea.val();

			if (curVal.length) {
				$textarea.val(curVal + " >>" + mID);
			} else {
				$textarea.val(">>" + mID);
			}
			$textarea.focus();
		},

		deleteLocalStorage: function (ev) {
			this.persistentLog.destroy();
			this.chatLog.clearChat(); // visually reinforce to the user that it deleted them by clearing the chatlog
			this.chatLog.clearMedia(); // "
		},

		logOut: function (ev) {
			// clears all sensitive information:
			$.cookie("nickname:" + this.channelName, null);
			$.cookie("ident_pw:" + this.channelName, null);
			$.cookie("channel_pw:" + this.channelName, null);
			this.clearCryptoKey(); // delete their stored key
			this.deleteLocalStorage();
			window.events.trigger("leaveChannel", this.channelName);

			// visually re-inforce the destruction:
			var growl = new Mewl({
				title: this.channelName + ":",
				body: "All local data erased.",
				lifespan: 7000
			});
		},

		clearChatlog: function () {
			this.chatLog.clearChat();
		},

		startIdleTimer: function () {
			var self = this;
			this.idleTimer = setTimeout(function () {
				if (self.me) {
					self.me.inactive("", self.channelName, self.socket);
				}
			}, 1000*30);
		},

		rerenderInputBox: function () {
			$(".chatinput", this.$el).remove(); // remove old
			// re-render the chat input area now that we've encrypted:
			this.$el.append(this.inputTemplate({
				encrypted: (typeof this.me.cryptokey !== "undefined")
			}));
		},

		showCryptoModal: function () {
			var self = this;

			var modal = new this.cryptoModal({
				channelName: this.channelName
			});

			modal.on("setKey", function (data) {
				if (data.key !== "") {
					self.me.cryptokey = data.key;
					window.localStorage.setItem("chat:cryptokey:" + self.channelName, data.key);
				}
				self.rerenderInputBox();
				$(".chatinput textarea", self.$el).focus();
				self.me.setNick(self.me.get("nick"), self.channelName);
			});
		},

		clearCryptoKey: function () {
			delete this.me.cryptokey;
			this.rerenderInputBox();
			window.localStorage.setItem("chat:cryptokey:" + this.channelName, "");
			this.me.unset("encrypted_nick");
			this.me.setNick("Anonymous", this.channelName);
		}
	});
});