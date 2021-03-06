/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Thunderbird Conversations
 *
 * The Initial Developer of the Original Code is
 *  Jonathan Protzenko <jonathan.protzenko@gmail.com>
 * Portions created by the Initial Developer are Copyright (C) 2010
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

"use strict";

var EXPORTED_SYMBOLS = ['Message', 'MessageFromGloda', 'MessageFromDbHdr']

const Ci = Components.interfaces;
const Cc = Components.classes;
const Cu = Components.utils;
const Cr = Components.results;

Cu.import("resource://gre/modules/XPCOMUtils.jsm"); // for generateQI
Cu.import("resource://gre/modules/PluralForm.jsm");
Cu.import("resource://gre/modules/Services.jsm"); // https://developer.mozilla.org/en/JavaScript_code_modules/Services.jsm
Cu.import("resource:///modules/mailServices.js"); // bug 629462
Cu.import("resource:///modules/StringBundle.js"); // for StringBundle
Cu.import("resource:///modules/templateUtils.js"); // for makeFriendlyDateAgo
Cu.import("resource:///modules/gloda/utils.js");
Cu.import("resource:///modules/gloda/mimemsg.js");
Cu.import("resource:///modules/gloda/connotent.js"); // for mimeMsgToContentSnippetAndMeta

// It's not really nice to write into someone elses object but this is what the
// Services object is for.  We prefix with the "m" to ensure we stay out of their
// namespace.
XPCOMUtils.defineLazyGetter(Services, "mMessenger",
                            function () {
                              return Cc["@mozilla.org/messenger;1"].createInstance(Ci.nsIMessenger);
                            });
XPCOMUtils.defineLazyServiceGetter(Services, "mFaviconService",
                            "@mozilla.org/browser/favicon-service;1",
                            "nsIFaviconService");

const kCharsetFromMetaTag = 9;
const kCharsetFromChannel = 11;
const kAllowRemoteContent = 2;

let strings = new StringBundle("chrome://conversations/locale/message.properties");

Cu.import("resource://conversations/stdlib/addressBookUtils.js");
Cu.import("resource://conversations/stdlib/msgHdrUtils.js");
Cu.import("resource://conversations/stdlib/compose.js");
Cu.import("resource://conversations/stdlib/misc.js");
Cu.import("resource://conversations/plugins/helpers.js");
Cu.import("resource://conversations/quoting.js");
Cu.import("resource://conversations/contact.js");
Cu.import("resource://conversations/prefs.js");
Cu.import("resource://conversations/misc.js"); // for iconForMimeType
Cu.import("resource://conversations/hook.js");
Cu.import("resource://conversations/log.js");

let Log = setupLogging("Conversations.Message");
// This is high because we want enough snippet to extract relevant data from
// bugzilla snippets.
const kSnippetLength = 700;

// Add in the global message listener table a weak reference to the given
//  Message object. The monkey-patch which intercepts the "remote content
//  blocked" notification will then look for a suitable listener and notify it
//  of the aforementioned event.
function addMsgListener(aMessage) {
  let window = topMail3Pane(aMessage);
  let weakPtr = Cu.getWeakReference(aMessage);
  let msgListeners = window.Conversations.msgListeners;
  let messageId = aMessage._msgHdr.messageId;
  if (!(messageId in msgListeners))
    msgListeners[messageId] = [];
  msgListeners[messageId].push(weakPtr);
}

let isOSX = ("nsILocalFileMac" in Components.interfaces);

function isAccel (event) (isOSX && event.metaKey || event.ctrlKey)

function KeyListener(aMessage) {
  this.message = aMessage;
  this.mail3PaneWindow = topMail3Pane(aMessage);
  this.KeyEvent = this.mail3PaneWindow.KeyEvent;
  this.navigator = this.mail3PaneWindow.navigator;
}

KeyListener.prototype = {
  // Any event that's handled *must* be stopped from bubbling upwards, because
  //  there's a topmost event listener on the DOM window that re-fires any
  //  keypress (that one is not capturing) into the main window. We have to do
  //  this because otherwise events dont make it out of the <browser
  //  id="multimessage"> that holds us when the conversation view has focus.
  // That's what makes cmd/ctrl-n work properly.
  onKeyUp: function _KeyListener_onKeyPressed (event) {
    let self = this;
    let findMsgNode = function (msgNode) {
      let msgNodes = self.message._domNode.ownerDocument
        .getElementsByClassName(Message.prototype.cssClass);
      msgNodes = [x for each ([, x] in Iterator(msgNodes))];
      let index = msgNodes.indexOf(msgNode);
      return [msgNodes, index];
    };
    switch (event.which) {
      case this.KeyEvent.DOM_VK_RETURN:
      case 'O'.charCodeAt(0):
        if (!isAccel(event)) {
          this.message.toggle();
          event.preventDefault();
          event.stopPropagation();
        }
        break;

      case 'F'.charCodeAt(0):
        if (!isAccel(event)) {
          let [msgNodes, index] = findMsgNode(this.message._domNode);
          if (index < (msgNodes.length - 1)) {
            let next = msgNodes[index+1];
            next.focus();
            this.message._conversation._htmlPane
              .contentWindow.scrollNodeIntoView(next);
          }
          event.preventDefault();
          event.stopPropagation();
        }
        break;

      case 'B'.charCodeAt(0):
        if (!isAccel(event)) {
          let [msgNodes, index] = findMsgNode(this.message._domNode);
          if (index > 0) {
            let prev = msgNodes[index-1];
            prev.focus();
            this.message._conversation._htmlPane
              .contentWindow.scrollNodeIntoView(prev);
          }
          event.preventDefault();
          event.stopPropagation();
        }
        break;

      case 'R'.charCodeAt(0):
        if (isAccel(event)) {
          if (event.shiftKey) {
            this.message.compose(Ci.nsIMsgCompType.ReplyAll, event);
          } else {
            this.message.compose(Ci.nsIMsgCompType.ReplyToSender, event);
          }
          event.preventDefault();
          event.stopPropagation();
        }
        break;

      case 'L'.charCodeAt(0):
        if (isAccel(event)) {
          this.message.forward(event);
          event.preventDefault();
          event.stopPropagation();
        }
        break;

      case 'U'.charCodeAt(0):
        if (!isAccel(event)) {
          // Hey, let's move back to this message next time!
          this.message._domNode.setAttribute("tabindex", "1");
          this.mail3PaneWindow.SetFocusThreadPane(event);
        } else {
          topMail3Pane(this.message).ViewPageSource([this.message._uri])
        }
        event.preventDefault();
        event.stopPropagation();
        break;

      case 'A'.charCodeAt(0):
        if (!isAccel(event)) {
          msgHdrsArchive(this.message._conversation.msgHdrs);
          event.preventDefault();
          event.stopPropagation();
        }
        break;

      case this.KeyEvent.DOM_VK_DELETE:
        if (!isAccel(event)) {
          this.message.removeFromConversation();
          event.preventDefault();
          event.stopPropagation();
        }
        break;

      default:
        // Tag handling.
        // 0 removes all tags, 1 to 9 set the corresponding tag, if it exists
        if (event.which >= '0'.charCodeAt(0)
            && event.which <= '9'.charCodeAt(0)) {
          let i = event.which - '1'.charCodeAt(0);
          if (i == -1) {
            this.message.tags = [];
          } else {
            let tag = MailServices.tags.getAllTags({})[i];
            if (tag) {
              if (this.message.tags.some(function (x) x.key == tag.key))
                this.message.tags = this.message.tags
                  .filter(function (x) x.key != tag.key);
              else
                this.message.tags = this.message.tags.concat([tag]);
            }
          }
          this.message.onAttributesChanged(this.message);
          event.preventDefault();
          event.stopPropagation();
        }
    }
  },
};

// Call that one after setting this._msgHdr;
function Message(aConversation) {
  this._didStream = false;
  this._domNode = null;
  this._snippet = "";
  this._conversation = aConversation;

  let date = new Date(this._msgHdr.date/1000);
  this._date = Prefs["no_friendly_date"] ? dateAsInMessageList(date) : makeFriendlyDateAgo(date);
  // This one is for display purposes
  this._from = this.parse(this._msgHdr.mime2DecodedAuthor)[0];
  // Might be filled to something more meaningful later, in case we replace the
  //  sender with something more relevant, like X-Bugzilla-Who.
  this._realFrom = "";
  this._to = this.parse(this._msgHdr.mime2DecodedRecipients);
  this._cc = this._msgHdr.ccList.length ? this.parse(this._msgHdr.ccList) : [];
  this._bcc = this._msgHdr.bccList.length ? this.parse(this._msgHdr.bccList) : [];
  this.subject = this._msgHdr.mime2DecodedSubject;

  this._uri = msgHdrGetUri(this._msgHdr);
  this._contacts = [];
  this._attachments = [];

  // A list of email addresses
  this.mailingLists = [];
  this.isReplyListEnabled = null;
  this.isReplyAllEnabled = null;
  this.bugzillaInfos = {};

  // Filled by the conversation, useful to know whether we were initially the
  //  first message in the conversation or not...
  this.initialPosition = -1;
}

Message.prototype = {
  cssClass: "message",

  // Wraps the low-level header parser stuff.
  //  @param aMimeLine a line that looks like "John <john@cheese.com>, Jane <jane@wine.com>"
  //  @return a list of { email, name } objects
  parse: function (aMimeLine) {
    return parseMimeLine(aMimeLine);
  },

  get inView () {
    return this._domNode.classList.contains("inView");
  },

  set inView (v) {
    if (v)
      this._domNode.classList.add("inView");
    else
      this._domNode.classList.remove("inView");
  },

  RE_SNIPPET: /[\u0000-\u0008\u000b-\u000c\u000e-\u001f]/g,
  RE_BZ_COMMENT: /^--- Comment #\d+ from .* \d{4}.*? ---([\s\S]*)/m,
  RE_MSGKEY: /number=(\d+)/,


  // This function is called before toTmplData, and allows us to adjust our
  // template data according to the message that came before us.
  updateTmplData: function (aPrevMsg) {
    let oldInfos = aPrevMsg && aPrevMsg.bugzillaInfos;
    if (!oldInfos)
      oldInfos = {};
    let infos = this.bugzillaInfos;
    let makeArrow = function (oldValue, newValue) {
      if (oldValue)
        return oldValue + " \u21d2 " + newValue;
      else
        return newValue;
    };
    if (Object.keys(infos).length) {
      let items = [];
      for each (let k in ["product", "component", "keywords", "severity",
          "status", "priority", "assigned-to", "target-milestone"]) {
        if ((!aPrevMsg || k in oldInfos) && oldInfos[k] != infos[k]) {
          let key =
            k.split("-").map(function (x) x.charAt(0).toUpperCase() + x.slice(1))
            .join(" ");
          items.push(key+": "+makeArrow(oldInfos[k], infos[k]));
        }
      }
      if (infos["changed-fields"] && String.trim(infos["changed-fields"]).length)
        items.push("Changed: "+infos["changed-fields"]);
      let m = this._snippet.match(this.RE_BZ_COMMENT);
      if (m && m.length && String.trim(m[1]).length)
        items.push(m[1]);
      if (!items.length)
        items.push(this._snippet);

      this._snippet = items.join("; ");
    }
  },

  // Output this message as a whole bunch of HTML
  toTmplData: function (aQuickReply) {
    let self = this;
    let data = {
      dataContactFrom: null,
      dataContactsTo: null,
      snippet: null,
      date: null,
      fullDate: null,
      attachmentsPlural: null,
      attachments: [],
      folderName: null,
      shortFolderName: null,
      draft: null,
      gallery: false,
      uri: null,
      quickReply: aQuickReply,
      bugzillaClass: "",
      bugzillaUrl: "[unknown bugzilla instance]",
    };

    // 1) Generate Contact objects
    let contactFrom = this._conversation._contactManager
      .getContactFromNameAndEmail(this._from.name, this._from.email);
    this._contacts.push(contactFrom);
    // true means "with colors"
    data.dataContactFrom = contactFrom.toTmplData(true, Contacts.kFrom);
    data.dataContactFrom.separator = "";

    let to = this._to.concat(this._cc).concat(this._bcc);
    let contactsTo = to.map(function (x) {
      return self._conversation._contactManager
        .getContactFromNameAndEmail(x.name, x.email);
    });
    this._contacts = this._contacts.concat(contactsTo);
    // false means "no colors"
    data.dataContactsTo = contactsTo.map(function (x) x.toTmplData(false, Contacts.kTo));
    let l = data.dataContactsTo.length;
    for each (let [i, data] in Iterator(data.dataContactsTo)) {
      if (i == 0)
        data.separator = "";
      else if (i < l - 1)
        data.separator = strings.get("sepComma");
      else
        data.separator = strings.get("sepAnd");
    }

    // 1b) Don't show "to me" if this is a bugzilla email
    if (Object.keys(this.bugzillaInfos).length) {
      data.bugzillaClass = "bugzilla";
      try {
        let url = this.bugzillaInfos["url"];
        let uri = Services.io.newURI(url, null, null);
        data.bugzillaUrl = url;
      } catch (e if e.result == Cr.NS_ERROR_MALFORMED_URI) {
        // why not?
      }
    }

    // 2) Generate Attachment objects
    l = this._attachments.length;
    let [makePlural, ] = PluralForm.makeGetter(strings.get("pluralForm"));
    data.attachmentsPlural = makePlural(l, strings.get("attachments")).replace("#1", l);
    for each (let [i, att] in Iterator(this._attachments)) {
      // Special treatment for images
      let isImage = (att.contentType.indexOf("image/") === 0);
      if (isImage)
        data.gallery = true;
      let key = self._msgHdr.messageKey;
      let url = att.url.replace(self.RE_MSGKEY, "number="+key);
      let [thumb, imgClass] = isImage
        ? [url, "resize-me"]
        : ["chrome://conversations/skin/icons/"+iconForMimeType(att.contentType), "icon"]
      ;

      // This is bug 630011, remove when fixed
      let formattedSize = "?";
      try {
        formattedSize = Services.mMessenger.formatFileSize(att.size);
      } catch (e) {
        Log.error(e);
      }

      // We've got the right data, push it!
      data.attachments.push({
        formattedSize: formattedSize,
        thumb: escapeHtml(thumb),
        imgClass: imgClass,
        name: escapeHtml(att.name),
      });
    }

    // 3) Generate extra information: snippet, date, uri
    data.snippet = escapeHtml(this._snippet).replace(this.RE_SNIPPET, "");
    data.date = escapeHtml(this._date);
    data.fullDate = Prefs["no_friendly_date"]
      ? ""
      : dateAsInMessageList(new Date(this._msgHdr.date/1000))
    ;
    data.uri = escapeHtml(msgHdrGetUri(this._msgHdr));

    // 4) Custom tag telling the user if the message is not in the current view
    let folderStr = this._msgHdr.folder.prettiestName;
    let folder = this._msgHdr.folder;
    while (folder.parent) {
      folder = folder.parent;
      folderStr = folder.name + "/" + folderStr;
    }
    data.folderName = escapeHtml(folderStr);
    data.shortFolderName = escapeHtml(this._msgHdr.folder.name);

    // 5) Custom tag telling the user if this is a draft
    data.draft = msgHdrIsDraft(this._msgHdr);

    // 6) For the "show remote content" thing
    data.realFrom = escapeHtml(this._realFrom.email || this._from.email);

    return data;
  },

  // Once the conversation has added us into the DOM, we're notified about it
  //  (aDomNode is us), and we can start registering event handlers and stuff
  onAddedToDom: function (aDomNode) {
    if (!aDomNode) {
      Log.error("onAddedToDom() && !aDomNode", this.from, this.to, this.subject);
    }

    // This allows us to pre-set the star and the tags in the right original
    //  state
    this._domNode = aDomNode;
    this.onAttributesChanged(this);

    let self = this;
    this._domNode.getElementsByClassName("messageHeader")[0]
      .addEventListener("click", function () {
        self._conversation._runOnceAfterNSignals(function () {
          if (self.expanded)
            self._conversation._htmlPane.contentWindow.scrollNodeIntoView(self._domNode);
        }, 1);
        self.toggle();
      }, false);

    let keyListener = new KeyListener(this);
    this._domNode.addEventListener("keydown", function (event) {
      keyListener.onKeyUp(event);
    }, false); // über-important: don't capture

    // Do this now because the star is visible even if we haven't been expanded
    // yet.
    this.register(".star", function (event) {
      self.starred = !self.starred;
      // Don't trust gloda. Big hack, self also has the "starred" property, so
      //  we don't have to create a new object.
      self.onAttributesChanged(self);
      event.stopPropagation();
    });
    this.register(".top-right-more", function (event) {
      event.stopPropagation();
    });
  },

  notifiedRemoteContentAlready: false,

  // The global monkey-patch finds us through the weak pointer table and
  //  notifies us.
  onMsgHasRemoteContent: function _Message_onMsgHasRemoteContent () {
    if (this.notifiedRemoteContentAlready)
      return;
    this.notifiedRemoteContentAlready = true;
    Log.debug("This message's remote content was blocked");

    this._domNode.getElementsByClassName("remoteContent")[0].style.display = "block";
  },

  // Actually, we only do these expensive DOM calls when we need to, i.e. when
  //  we're expanded for the first time (expand calls us).
  registerActions: function _Message_registerActions() {
    let self = this;
    let mainWindow = topMail3Pane(this);

    // Forward the calls to each contact.
    let people = this._domNode.getElementsByClassName("tooltip");
    [x.onAddedToDom(people[i]) for each ([i, x] in Iterator(this._contacts))];

    // Let the UI do its stuff with the tooltips
    this._conversation._htmlPane.contentWindow.enableTooltips(this);

    // Register all the needed event handlers. Nice wrappers below.
    this.register(".details", function (event) {
      self._domNode.classList.add("with-details");
      event.stopPropagation();
    });

    // This is for the smart reply button, we need to determine what's the best
    // action.
    this.register(".menuReply", function (event) self.compose(Ci.nsIMsgCompType.ReplyToSender, event));
    this.register(".menuReplyAll", function (event) self.compose(Ci.nsIMsgCompType.ReplyAll, event));
    this.register(".menuReplyList", function (event) self.compose(Ci.nsIMsgCompType.ReplyToList, event));
    let mainAction = self._domNode.getElementsByClassName("replyMainAction")[0];
    let replyList = self._domNode.getElementsByClassName("menuReplyList")[0];
    let replyAll = self._domNode.getElementsByClassName("menuReplyAll")[0];
    let reply = self._domNode.getElementsByClassName("menuReply")[0];
    // Hide items if needed
    if (!this.isReplyListEnabled)
      replyList.style.display = "none";
    if (!this.isReplyAllEnabled)
      replyAll.style.display = "none";
    // Register the right actions
    if (this.isReplyAllEnabled) {
      this.register(".replyMainAction", function (event) self.compose(Ci.nsIMsgCompType.ReplyAll, event));
      mainAction.textContent = replyAll.textContent;
    } else {
      this.register(".replyMainAction", function (event) self.compose(Ci.nsIMsgCompType.ReplyToSender, event));
      mainAction.textContent = reply.textContent;
    }

    this.register(".edit-draft", function (event) self.compose(Ci.nsIMsgCompType.Draft, event));
    this.register(".action-edit-new", function (event) self.compose(Ci.nsIMsgCompType.Template, event));
    this.register(".action-compose-all", function (event) {
      let allEmails =
        self._msgHdr.author + "," +
        self._msgHdr.recipients + "," +
        self._msgHdr.ccList + "," +
        self._msgHdr.bccList
      ;
      allEmails = MailServices.headerParser.removeDuplicateAddresses(allEmails, "");
      let emailAddresses = {};
      let names = {};
      let numAddresses = MailServices.headerParser
                          .parseHeadersWithArray(allEmails, emailAddresses, names, {});
      allEmails = [
        (names.value[i] ? (names.value[i] + " <" + x + ">") : x)
        for each ([i, x] in Iterator(emailAddresses.value))
        if (!(x.toLowerCase() in gIdentities))
      ];
      let composeAllUri = "mailto:" + allEmails.join(",");
      let uri = Services.io.newURI(composeAllUri, null, null);
      MailServices.compose.OpenComposeWindowWithURI(null, uri);
    });
    this.register(".forward", function (event) self.forward(event));
    // These event listeners are all in the header, which happens to have an
    //  event listener set on the click event for toggling the message. So we
    //  make sure that event listener is bubbling, and we register these with
    //  the bubbling model as well.
    this.register(".action-archive", function (event) {
      msgHdrsArchive([self._msgHdr]);
      event.stopPropagation();
    });
    this.register(".action-delete", function (event) {
      // We do this, otherwise we end up with messages in the conversation that
      //  don't have a message header, and that breaks pretty much all the
      //  assumptions...
      self.removeFromConversation();
      event.stopPropagation();
    });

    // Pre-set the right value
    let realFrom = String.trim(this._realFrom.email || this._from.email);
    if (realFrom in Prefs["monospaced_senders"])
      this._domNode.getElementsByClassName("checkbox-monospace")[0].checked = true;

    // This one is located in the first contact tooltip
    this.register(".checkbox-monospace", function (event) {
      let senders = Object.keys(Prefs["monospaced_senders"]);
      senders = senders.filter(function (x) x != realFrom);
      if (event.target.checked) {
        Prefs.setChar("conversations.monospaced_senders", senders.concat([realFrom]).join(","));
      } else {
        Prefs.setChar("conversations.monospaced_senders", senders.join(","));
      }
      self._reloadMessage();
      event.stopPropagation();
    });
    this.register(".action-classic", function (event) {
      let tabmail = mainWindow.document.getElementById("tabmail");
      tabmail.openTab("message", { msgHdr: self._msgHdr, background: false });
      event.stopPropagation();
    });
    this.register(".action-source", function (event) {
      mainWindow.ViewPageSource([self._uri])
      event.stopPropagation();
    });
    this.register(".tooltip", function (event) {
      // Clicking inside a tooltip must not collapse the message.
      event.stopPropagation();
    });

    this.register(".ignore-warning", function (event) {
      self._domNode.getElementsByClassName("phishingBar")[0].style.display = "none";
      self._msgHdr.setUint32Property("notAPhishMessage", 1);
      // Force a commit of the underlying msgDatabase.
      self._msgHdr.folder.msgDatabase = null;
    });
    this.register(".show-remote-content", function (event) {
      self._domNode.getElementsByClassName("show-remote-content")[0].style.display = "none";
      self._msgHdr.setUint32Property("remoteContentPolicy", kAllowRemoteContent);
      self._msgHdr.folder.msgDatabase = null;
      self._reloadMessage();
    });
    this.register(".always-display", function (event) {
      self._domNode.getElementsByClassName("remoteContent")[0].style.display = "none";

      let { card, book } = mainWindow.getCardForEmail(self._from.email);
      if (card) {
        // set the property for remote content
        card.setProperty("AllowRemoteContent", true);
        book.modifyCard(card);
      } else {
        saveEmailInAddressBook(
          getAddressBookFromUri(kCollectedAddressBookUri),
          self._from.email,
          self._from.name
        );
      }
      self._reloadMessage();
    });
    this.register(".messageBody .in-folder", function (event) {
      mainWindow.gFolderTreeView.selectFolder(self._msgHdr.folder, true);
      mainWindow.gFolderDisplay.selectMessage(self._msgHdr);
    });

    let attachmentNodes = this._domNode.getElementsByClassName("attachment");
    let attachmentInfos = [];
    for each (let [i, attNode] in Iterator(attachmentNodes)) {
      let att = this._attachments[i];
      // The message keys can change over time, so do not assume that the msgkey
      // that was picked at indexing-time is still valid.
      let key = self._msgHdr.messageKey;
      let url = att.url.replace(self.RE_MSGKEY, "number="+key);

      // I'm still surprised that this magically works
      let uri = Services.io.newURI(url, null, null)
                        .QueryInterface(Ci.nsIMsgMessageUrl)
                        .uri;

      // New versions of Thunderbird (post-5.0) have changed the API for
      // attachment objects. Handle both ways for now.
      let newAttAPI = ("AttachmentInfo" in mainWindow);
      let attInfo;
      if (newAttAPI)
        attInfo = new mainWindow.AttachmentInfo(
          att.contentType, url, att.name, uri, att.isExternal
        );
      else
        attInfo = new mainWindow.createNewAttachmentInfo(
          att.contentType, url, att.name, uri, att.isExternal
        );

      this.register(attNode.getElementsByClassName("open-attachment")[0], function (event) {
        try {
          if (newAttAPI)
            attInfo.open();
          else
            mainWindow.openAttachment(attInfo);
        } catch (e) {
          Log.warn(e);
        }
      });
      this.register(attNode.getElementsByClassName("download-attachment")[0], function (event) {
        try {
          if (newAttAPI)
            attInfo.save();
          else
            mainWindow.saveAttachment(attInfo);
        } catch (e) {
          Log.warn(e);
        }
      });

      let maybeViewable = 
        att.contentType.indexOf("image/") === 0
        || att.contentType.indexOf("text/") === 0
      ;
      if (maybeViewable) {
        let img = attNode.getElementsByTagName("img")[0];
        img.classList.add("view-attachment");
        img.setAttribute("title", strings.get("viewAttachment"));
        this.register(img, function (event) {
          mainWindow.document.getElementById("tabmail").openTab(
            "contentTab",
            { contentPage: url }
          );
        });
      }

      // Drag & drop
      attNode.addEventListener("dragstart", function (event) {
        // mail/base/content/mailCore.js:602
        let info;
        if (/(^file:|&filename=)/.test(url))
          info = url;
        else
          info = url + "&type=" + att.contentType +
                     "&filename=" + encodeURIComponent(att.name);
        event.dataTransfer.setData("text/x-moz-url",
                                   info + "\n" + att.name + "\n" + att.size);
        event.dataTransfer.setData("text/x-moz-url-data", url);
        event.dataTransfer.setData("text/x-moz-url-desc", att.name);
        event.dataTransfer.setData("application/x-moz-file-promise-url",
                                   url);
        // XXX I have no idea whether this is useful...
        event.dataTransfer.setData("application/x-moz-file-promise", null);
      }, false);

      attachmentInfos.push(attInfo);
    }
    this.register(".open-all", function (event) {
      mainWindow.HandleMultipleAttachments(attachmentInfos, "open");
    });
    this.register(".download-all", function (event) {
      mainWindow.HandleMultipleAttachments(attachmentInfos, "save");
    });
    this.register(".quickReply", function (event) {
      // Ok, so it's actually convenient to register our event listener on the
      //  .quickReply node because we can easily prevent it from bubbling
      //  upwards, but the problem is, if a message is appended at the end of
      //  the conversation view, this event listener is active and the one from
      //  the new message is active too. So we check that the quick reply still
      //  is inside our dom node.
      if (!self._domNode.getElementsByClassName("quickReply").length)
        return;

      let window = self._conversation._htmlPane.contentWindow;

      switch (event.keyCode) {
        case mainWindow.KeyEvent.DOM_VK_RETURN:
          if (isAccel(event)) {
            if (event.shiftKey)
              window.gComposeSession.send({ archive: true });
            else
              window.gComposeSession.send();
          }
          break;

        case mainWindow.KeyEvent.DOM_VK_ESCAPE:
          Log.debug("Escape from quickReply");
          self._domNode.focus();
          break;

        default:
          window.startedEditing(true);
      }
      event.stopPropagation();
    }, { action: "keydown" });
  },

  _reloadMessage: function _Message_reloadMessage () {
    // The second one in for when we're expanded.
    let specialTags = this._domNode.getElementsByClassName("special-tags")[1];
    // Remove any extra tags because they will be re-added after reload, but
    //  leave the "show remote content" tag.
    for (let i = specialTags.children.length - 1; i >= 0; i--) {
      let child = specialTags.children[i];
      if (!child.classList.contains("keep-tag"))
        specialTags.removeChild(child);
    }
    this.iframe.parentNode.removeChild(this.iframe);
    this.streamMessage();
  },

  get iframe () {
    return this._domNode.getElementsByTagName("iframe")[0];
  },

  cosmeticFixups: function _Message_cosmeticFixups() {
    let self = this;
    let window = this._conversation._htmlPane.contentWindow;
    window.alignAttachments(this);

    let toNode = this._domNode.getElementsByClassName("to")[0];
    let children = toNode.children;
    let hide = function (aNode) aNode.classList.add("show-with-details");
    let width = function (x) x.offsetWidth;
    let baseSize = isOSX ? 15 : 16;
    let textSize = Prefs.tweak_chrome
      ? Math.round(100 * this.defaultSize * 12 / baseSize) / 100
      : this.defaultSize;
    let lineHeight = textSize * 1.8; // per the CSS file
    let overflows = function () parseInt(toNode.offsetHeight) > lineHeight;

    if (overflows()) {
      let dots = toNode.ownerDocument.createElement("a");
      dots.setAttribute("href", "javascript:null");
      dots.classList.add("link");
      dots.classList.add("hide-with-details");
      // We need to be conservative here, because if we don't set the number,
      // then setting it in the end might trigger one more overflow...
      dots.textContent = strings.get("andNMore", [999]);
      dots.addEventListener("click", function (event) {
        self._domNode.classList.add("with-details");
        event.stopPropagation();
      }, false);
      toNode.appendChild(toNode.ownerDocument.createTextNode(" "));
      toNode.appendChild(dots);
      // We need to hide an even number of nodes, so that there's no sepComma or
      // sepAnd at the end of the list.
      let nHidden = 0;

      // First find out how many names it takes to fill the message's width
      let approximateWidth = width(this._domNode);
      let total = 0;
      let i = 0;
      let j = toNode.children.length - 1;
      while (total < approximateWidth && i < j) {
        total += width(children[i]);
        i++;
      }
      // Hide all the others
      [(hide(children[x]), ++nHidden) for (x in range(i, j))];
      // And move backwards to hide just enough items (usually one or two) until
      //  we fit perfectly.
      i--;
      while (overflows() && i >= 0) {
        (hide(children[i]), ++nHidden);
        i--;
      }
      if (nHidden % 2)
        (hide(children[i]), ++nHidden);
      dots.textContent = strings.get("andNMore", [nHidden/2]);
    }
  },

  // {
  //  starred: bool,
  //  tags: nsIMsgTag list,
  // } --> both Message and GlodaMessage implement these attributes
  onAttributesChanged: function _Message_onAttributesChanged({ starred, tags }) {
    // Update "starred" attribute
    if (starred)
      this._domNode.getElementsByClassName("star")[0].classList.add("starred");
    else
      this._domNode.getElementsByClassName("star")[0].classList.remove("starred");

    // Update tags
    let tagList = this._domNode.getElementsByClassName("regular-tags")[1];
    while (tagList.firstChild)
      tagList.removeChild(tagList.firstChild);
    for each (let [, mtag] in Iterator(tags)) {
      let tag = mtag;
      let document = this._domNode.ownerDocument;
      let colorClass = "blc-" + MailServices.tags.getColorForKey(tag.key).substr(1);
      let tagName = tag.tag;
      let tagNode = document.createElement("li");
      tagNode.classList.add("tag");
      tagNode.classList.add(colorClass);
      tagNode.appendChild(document.createTextNode(tagName));
      let span = document.createElement("span");
      span.textContent = " x";
      span.classList.add("tag-x");
      span.addEventListener("click", function (event) {
        let tags = this.tags.filter(function (x) x.key != tag.key);
        this.tags = tags;
        // And now let onAttributesChanged kick in... NOT
        tagList.removeChild(tagNode);
      }.bind(this), false);
      tagNode.appendChild(span);
      tagList.appendChild(tagNode);
    }
    this._domNode.getElementsByClassName("regular-tags")[0].innerHTML = tagList.innerHTML;
  },

  removeFromConversation: function _Message_removeFromConversation() {
    this._conversation.removeMessage(this);
    msgHdrsDelete([this._msgHdr]);
    let w = this._conversation._window;
    if (w.isInTab && !this._conversation.messages.length)
      w.closeTab();
  },

  // Convenience properties
  get read () {
    return this._msgHdr.isRead;
  },

  get starred () {
    return this._msgHdr.isFlagged;
  },

  set starred (v) {
    this._msgHdr.markFlagged(v);
  },

  get tags () {
    return msgHdrGetTags(this._msgHdr);
  },

  set tags (v) {
    return msgHdrSetTags(this._msgHdr, v);
  },

  get collapsed () {
    return this._domNode.classList.contains("collapsed");
  },

  get expanded () {
    return !this.collapsed;
  },

  toggle: function () {
    if (this.collapsed)
      this.expand();
    else if (this.expanded)
      this.collapse();
    else
      Log.error("WTF???");
  },

  _signal: function _Message_signal () {
    this._conversation._signal();
  },

  expand: function () {
    this._domNode.classList.remove("collapsed");
    if (!this._didStream) {
      try {
        this.registerActions();
        this.cosmeticFixups();
        this.streamMessage(); // will call _signal
      } catch (e) {
        Log.error(e);
        dumpCallStack(e);
      }
    } else {
      this._signal();
    }
  },

  collapse: function () {
    this._domNode.classList.add("collapsed");
  },

  // This function takes care of streaming the message into the <iframe>, adding
  // it into the DOM tree, watching for completion, reloading if necessary
  // (BidiUI), applying the various heuristics for detecting quoted parts,
  // changing the monospace font for the default one, possibly decrypting the
  // message using Enigmail, making coffee...
  streamMessage: function () {
    Log.assert(this.expanded, "Cannot stream a message if not expanded first!");

    let originalScroll = this._domNode.ownerDocument.documentElement.scrollTop;
    let msgWindow = topMail3Pane(this).msgWindow;
    let self = this;

    let iframe = this._domNode.ownerDocument
      .createElementNS("http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul", "iframe");
    iframe.setAttribute("style", "height: 20px");
    iframe.setAttribute("type", "content");

    let delay = 100;
    let timeout = topMail3Pane(this).setTimeout(function resize () {
      // Do a pre-computation of the height because of HTML newsletters that
      // don't fire the load event until the whole document is done loading.
      // This can take up to 1 minute if the server is slow delivering images
      // (true story).
      try {
        if (iframe.contentDocument && iframe.contentDocument.body)
          iframe.style.height = iframe.contentDocument.body.scrollHeight+"px";
        // Retry aggressively, because the backend may need a lot of time
        // to fetch the message in the message store, process it through libmime,
        // and output it into the xul:iframe. Every time we retry, we leave the
        // backend twice more time, until we've really waited for a long time...
        if (delay < 10000)
          timeout = topMail3Pane(self).setTimeout(resize, (delay = delay * 2));
      } catch (e) {
        Log.debug(e);
      }
    }, delay);

    // The xul:iframe automatically loads about:blank when it is added
    // into the tree. We need to wait for the document to be loaded before
    // doing things.
    //
    // Why do we do that? Basically because we want the <xul:iframe> to
    // have a docShell and a webNavigation. If we don't do that, and we
    // set directly src="about:blank" above, sometimes we are too fast and
    // the docShell isn't ready by the time we get there.
    iframe.addEventListener("load", function f_temp2(event, aCharset) {
      try {
        iframe.removeEventListener("load", f_temp2, true);

        // The second load event is triggered by loadURI with the URL
        // being the necko URL to the given message.
        iframe.addEventListener("load", function f_temp1(event) {
          try {
            iframe.removeEventListener("load", f_temp1, true);

            // Notify hooks that we just finished displaying a message. Must be
            //  performed now, not later. This gives plugins a chance to modify
            //  the DOM of the message (i.e. decrypt it) before we tweak the
            //  fonts and stuff.
            try {
              [h.onMessageStreamed(self._msgHdr, self._domNode, msgWindow) for each ([, h] in Iterator(getHooks()))];
            } catch (e) {
              Log.warn("Plugin returned an error:", e);
              dumpCallStack(e);
            }

            let iframeDoc = iframe.contentDocument;
            self.tweakFonts(iframeDoc);
            self.detectQuotes(iframe);
            if (self.checkForFishing(iframeDoc) && !self._msgHdr.getUint32Property("notAPhishMessage")) {
              Log.debug("Phishing attempt");
              self._domNode.getElementsByClassName("phishingBar")[0].style.display = "block";
            }

            // For bidiUI. Do that now because the DOM manipulations are
            //  over. We can't do this before because BidiUI screws up the
            //  DOM. Don't know why :(.
            // We can't do this as a plugin (I wish I could!) because this is
            //  too entangled with the display logic.
            let mainWindow = topMail3Pane(self);
            if ("BiDiMailUI" in mainWindow) {
              let ActionPhases = mainWindow.BiDiMailUI.Display.ActionPhases;
              try {
                let domDocument = iframe.docShell.contentViewer.DOMDocument;
                let body = domDocument.body;

                let BDMCharsetPhaseParams = {
                  body: body,
                  charsetOverrideInEffect: msgWindow.charsetOverride,
                  currentCharset: msgWindow.mailCharacterSet,
                  messageHeader: self._msgHdr,
                  unusableCharsetHandler: mainWindow
                    .BiDiMailUI.MessageOverlay.promptForDefaultCharsetChange,
                  needCharsetForcing: false,
                  charsetToForce: null
                };
                ActionPhases.charsetMisdetectionCorrection(BDMCharsetPhaseParams);
                if (BDMCharsetPhaseParams.needCharsetForcing
                    && BDMCharsetPhaseParams.charsetToForce != aCharset) {
                  // XXX this doesn't take into account the case where we
                  // have a cycle with length > 0 in the reloadings.
                  // Currently, I only see UTF8 -> UTF8 cycles.
                  Log.debug("Reloading with "+BDMCharsetPhaseParams.charsetToForce);
                  f_temp2(null, BDMCharsetPhaseParams.charsetToForce);
                  return;
                }
                ActionPhases.htmlNumericEntitiesDecoding(body);
                ActionPhases.quoteBarsCSSFix(domDocument);
                ActionPhases.directionAutodetection(domDocument);
              } catch (e) {
                Log.error(e);
                dumpCallStack(e);
              }
            }

            // Attach the required event handlers so that links open in the
            // external browser.
            for each (let [, a] in Iterator(iframeDoc.getElementsByTagName("a"))) {
              a.addEventListener("click",
                function link_listener (event)
                  mainWindow.specialTabs.siteClickHandler(event, /^mailto:/), true);
            }

            // Everything's done, so now we're able to settle for a height.
            mainWindow.clearTimeout(timeout);
            iframe.style.height = iframeDoc.body.scrollHeight+"px";

            // So now we might overflow horizontally, which causes a horizontal
            // scrollbar to appear, which narrows the vertical height available,
            // which causes a vertical scrollbar to appear.
            let iframeStyle = self._conversation._window.getComputedStyle(iframe, null);
            let iframeExternalWidth = parseInt(iframeStyle.width);
            // 20px is a completely arbitrary default value which I hope is
            // greater
            if (iframeDoc.body.scrollWidth > iframeExternalWidth) {
              Log.debug("Horizontal overflow detected.");
              iframe.style.height = (iframeDoc.body.scrollHeight + 20)+"px";
            }

            // Sometimes setting the iframe's content and height changes
            // the scroll value, don't know why.
            if (false && originalScroll) {
              self._domNode.ownerDocument.documentElement.scrollTop = originalScroll;
            }

            self._didStream = true;
            self._signal();
          } catch (e) {
            try {
              iframe.style.height = iframeDoc.body.scrollHeight+"px";
            } catch (e) {
              iframe.style.height = "800px";
            }
            Log.error(e);
            Log.warn("Running signal once more to make sure we move on with our life... (warning, this WILL cause bugs)");
            dumpCallStack(e);
            self._didStream = true;
            self._signal();
          }
        }, true); /* end iframe.addEventListener */

        /* Unbelievable as it may seem, the code below works.
         * Some references :
         * - http://mxr.mozilla.org/comm-central/source/mailnews/base/src/nsMessenger.cpp#564
         * - http://mxr.mozilla.org/comm-central/source/mailnews/base/src/nsMessenger.cpp#388
         * - https://developer.mozilla.org/@api/deki/files/3579/=MessageRepresentations.png
         *
         * According to dmose, we should get the regular content policy
         * for free (regarding image loading, JS...) by using a content
         * iframe with a classical call to loadURI. AFAICT, this works
         * pretty well (no JS is executed, the images are loaded IFF we
         * authorized that recipient).
         * */
        let url = msgHdrToNeckoURL(self._msgHdr);

        /* These steps are mandatory. Basically, the code that loads the
         * messages will always output UTF-8 as the OUTPUT ENCODING, so
         * we need to tell the iframe's docshell about it. */
        let cv;
        try {
          cv = iframe.docShell.contentViewer;
        } catch (e) {
          Log.error(e);
          dumpCallStack(e);
          Log.error("The iframe doesn't have a docShell, it probably doesn't belong to the DOM anymore."
            +" Possible reasons include: you modified the jquery-tmpl template, and you did it wrong."
            +" You changed conversations very fast, and the streaming completed after the conversation"
            +" was blown away by the newer one.");
        }
        cv.QueryInterface(Ci.nsIMarkupDocumentViewer);
        cv.hintCharacterSet = "UTF-8";
        cv.hintCharacterSetSource = kCharsetFromChannel;
        /* Is this even remotely useful? */
        iframe.docShell.appType = Ci.nsIDocShell.APP_TYPE_MAIL;

        /* Now that's about the input encoding. Here's the catch: the
         * right way to do that would be to query nsIMsgI18NUrl [1] on the
         * nsIURI and set charsetOverRide on it. For this parameter to
         * take effect, we would have to pass the nsIURI to LoadURI, not a
         * string as in url.spec, but a real nsIURI. Next step:
         * nsIWebNavigation.loadURI only takes a string... so let's have a
         * look at nsIDocShell... good, loadURI takes a a nsIURI there.
         * BUT IT'S [noscript]!!! I'm doomed.
         *
         * Workaround: call DisplayMessage that in turns calls the
         * docShell from C++ code. Oh and why are we doing this? Oh, yes,
         * see [2].
         *
         * Some remarks: I don't know if the nsIUrlListener [3] is useful,
         * but let's leave it like that, it might come in handy later. And
         * we _cannot instanciate directly_ the nsIMsgMessageService because
         * there are different ones for each type of account. So we must ask
         * nsIMessenger for it, so that it instanciates the right component.
         *
        [1] http://mxr.mozilla.org/comm-central/source/mailnews/base/public/nsIMsgMailNewsUrl.idl#172
        [2] https://www.mozdev.org/bugs/show_bug.cgi?id=22775
        [3] http://mxr.mozilla.org/comm-central/source/mailnews/base/public/nsIUrlListener.idl#48
        [4] http://mxr.mozilla.org/comm-central/source/mailnews/base/public/nsIMsgMessageService.idl#112
        */
        let messageService = Services.mMessenger.messageServiceFromURI(url.spec);
        let urlListener = {
          OnStartRunningUrl: function () {},
          OnStopRunningUrl: function () {},
          QueryInterface: XPCOMUtils.generateQI([Ci.nsISupports, Ci.nsIUrlListener])
        };
 
        /**
        * When you want a message displayed....
        *
        * @param in aMessageURI Is a uri representing the message to display.
        * @param in aDisplayConsumer Is (for now) an nsIDocShell which we'll use to load 
        *                         the message into.
        *                         XXXbz Should it be an nsIWebNavigation or something?
        * @param in aMsgWindow
        * @param in aUrlListener
        * @param in aCharsetOverride (optional) character set override to force the message to use.
        * @param out aURL
        */
        let params = "&markRead=false";
        messageService.DisplayMessage(self._uri+params, iframe.docShell,
                                      msgWindow, urlListener, aCharset, {});
      } catch (e) {
        Log.error(e);
        dumpCallStack(e);
      }
    }, true); /* end document.addEventListener */

    // Ok, brace ourselves for notifications happening during the message load
    //  process.
    addMsgListener(this);

    // This triggers the whole process. We assume (see beginning) that the
    // message is expanded which means the <iframe> will be visible right away
    // which means we can use offsetHeight, getComputedStyle and stuff on it.
    let container = this._domNode.getElementsByClassName("iframe-container")[0];
    container.appendChild(iframe);
  },

  /**
   * Returns the message's text, assuming it's been streamed already (i.e.
   * expanded). We're extracting a plaintext version of the body from what's in
   * the <iframe>, modulo a few cosmetic cleanups. The collapsed quoted parts
   * are *not* included.
   */
  get bodyAsText () {
    // This function tries to clean up the email's body by removing hidden
    // blockquotes, removing signatures, etc. Note: sometimes there's a little
    // quoted text left over, need to investigate why...
    let prepare = function (aNode) {
      let node = aNode.cloneNode(true);
      for each (let [, x] in Iterator(node.getElementsByClassName("moz-txt-sig")))
        if (x)
          x.parentNode.removeChild(x);
      for each (let [, x] in Iterator(node.querySelectorAll("blockquote, div")))
        if (x && x.style.display == "none")
          x.parentNode.removeChild(x);
      return node.innerHTML;
    };
    let body = htmlToPlainText(prepare(this.iframe.contentWindow.document.body))
    // Remove trailing newlines, it gives a bad appearance.
    body = body.replace(/[\n\r]*$/, "");
    return body;
  },

  /**
   * Fills the bodyContainer <div> with the plaintext contents of the message
   * for printing.
   */
  dumpPlainTextForPrinting: function _Message_dumpPlainTextForPrinting() {
    // printConversation from content/stub.xhtml calls us, regardless of whether
    // we've streamed the message yet, or not, so the iframe might not be ready
    // yet. That's ok, since we will print the snippet anyway.
    if (this.iframe) {
      // Fill the text node that will end up being printed. We can't
      // really print iframes, they don't wrap...
      let bodyContainer = this._domNode.getElementsByClassName("body-container")[0];
      bodyContainer.textContent = this.bodyAsText;
    }
  },

  /**
   * This function is called for the "Forward conversation" action. The idea is
   * that we want to forward a plaintext version of the message, so we try and
   * do our best to give this. We're trying not to stream it once more!
   */
  exportAsHtml: function _Message_exportAsHtml() {
    let author = escapeHtml(this._contacts[0]._name);
    let date = new Date(this._msgHdr.date/1000).toLocaleString("%x");
    // We try to convert the bodies to plain text, to enhance the readibility in
    // the forwarded conversation. Note: <pre> tags are not converted properly
    // it seems, need to investigate...
    let body = this.iframe
      ? this.bodyAsText
      : this._snippet
    ;
    // Do our little formatting...
    let html = [
      '<b><span style="color: #396BBD">', author, '</span></b><br />',
      '<span style="color: #666">', date, '</span><br />',
      '<br />',
      '<div style="white-space: pre-wrap; color: #666">',
        (this.iframe ? escapeHtml(body) : ("<i>" + escapeHtml(body) + "</i>...")),
      '</div>',
    ].join("");
    return html;
  },
}

MixIn(Message, EventHelperMixIn);

function MessageFromGloda(aConversation, aGlodaMsg) {
  this._msgHdr = aGlodaMsg.folderMessage;
  this._glodaMsg = aGlodaMsg;
  Message.apply(this, arguments);

  // Our gloda plugin found something for us, thanks dude!
  if (aGlodaMsg.alternativeSender) {
    this._realFrom = this._from;
    this._from = this.parse(aGlodaMsg.alternativeSender)[0];
  }

  if (aGlodaMsg.bugzillaInfos)
    this.bugzillaInfos = JSON.parse(aGlodaMsg.bugzillaInfos);

  // FIXME messages that have no body end up with "..." as a snippet
  this._snippet = aGlodaMsg._indexedBodyText
    ? aGlodaMsg._indexedBodyText.substring(0, kSnippetLength-1)
    : "..."; // it's probably an Enigmail message

  if ("attachmentInfos" in aGlodaMsg)
    this._attachments = aGlodaMsg.attachmentInfos;

  if ("mailingLists" in aGlodaMsg)
    this.mailingLists =
      [x.value for each ([, x] in Iterator(aGlodaMsg.mailingLists))];

  this.isReplyListEnabled =
    ("mailingLists" in aGlodaMsg) && aGlodaMsg.mailingLists.length;
  this.isReplyAllEnabled =
    [aGlodaMsg.from].concat(aGlodaMsg.to).concat(aGlodaMsg.cc).concat(aGlodaMsg.bcc)
    .filter(function (x) !(x.value in gIdentities)).length > 1;

  this._signal();
}

MessageFromGloda.prototype = {
  __proto__: Message.prototype,
}

function MessageFromDbHdr(aConversation, aMsgHdr) {
  this._msgHdr = aMsgHdr;
  Message.apply(this, arguments);

  // Gloda is not with us, so stream the message... the MimeMsg API says that
  //  the streaming will fail and the underlying exception will be re-thrown in
  //  case the message is not on disk. In that case, the fallback is to just get
  //  the body text and wait for it to be ready. This can be SLOW (like, real
  //  slow). But at least it works. (Setting the fourth parameter to true just
  //  leads to an empty snippet).
  let self = this;
  Log.warn("Streaming the message because Gloda has not indexed it, this is BAD");
  try {
    MsgHdrToMimeMessage(aMsgHdr, null, function(aMsgHdr, aMimeMsg) {
      try {
        if (aMimeMsg == null) {
          self._fallbackSnippet();
          return;
        }

        let [text, meta] = mimeMsgToContentSnippetAndMeta(aMimeMsg, aMsgHdr.folder, kSnippetLength);
        self._snippet = text;
        let alternativeSender = PluginHelpers.alternativeSender({ mime: aMimeMsg, header: aMsgHdr });
        if (alternativeSender) {
          self._realFrom = self._from;
          self._from = self.parse(alternativeSender)[0];
        }

        self.bugzillaInfos = PluginHelpers.bugzilla({ mime: aMimeMsg, header: aMsgHdr }) || {};

        self._attachments = aMimeMsg.allUserAttachments
          .filter(function (x) x.isRealAttachment);
        let listPost = aMimeMsg.get("list-post");
        if (listPost) {
          let r = listPost.match(self.RE_LIST_POST);
          if (r.length)
            self.mailingLists = [r[1]];
        }
        Log.debug(self.mailingLists);

        self.isReplyListEnabled = 
          aMimeMsg &&
          aMimeMsg.has("list-post") &&
          self.RE_LIST_POST.exec(aMimeMsg.get("list-post"))
        ;
        self.isReplyAllEnabled = 
          parseMimeLine(aMimeMsg.get("from"), true)
          .concat(parseMimeLine(aMimeMsg.get("to"), true))
          .concat(parseMimeLine(aMimeMsg.get("cc"), true))
          .concat(parseMimeLine(aMimeMsg.get("bcc"), true))
          .filter(function (x) !(x.email in gIdentities))
          .length > 1;

        self._signal();
      } catch (e) {
        Log.error(e);
        dumpCallStack(e);
      }
    }, true, {
      partsOnDemand: true,
    });
  } catch (e) {
    // Remember: these exceptions don't make it out of the callback (XPConnect
    // death trap, can't fight it until we reach level 3 and gain 1200 exp
    // points, so keep training)
    Log.warn("Gloda failed to stream the message properly, this is VERY BAD");
    Log.warn(e);
    this._fallbackSnippet();
  }
}

MessageFromDbHdr.prototype = {
  __proto__: Message.prototype,

  _fallbackSnippet: function _MessageFromDbHdr_fallbackSnippet () {
    Log.debug("Using the default streaming code...");
    let body = msgHdrToMessageBody(this._msgHdr, true, kSnippetLength);
    Log.debug("Body is", body);
    this._snippet = body.substring(0, kSnippetLength-1);
    this._signal();
  },

  RE_LIST_POST: /<mailto:([^>]+)>/,
}

/**
 * This additional class holds all of the bad heuristics we're performing on a
 *  message's inner DOM once it's been displayed in the conversation view. These
 *  include tweaking the fonts, detectin quotes, etc.
 * As it doesn't belong to the main logic, we're doing this in a separate class
 *  that's MixIn'd the Message class.
 */
let PostStreamingFixesMixIn = {
  // This is the naming convention to define a getter, per MixIn's definition
  get_defaultSize: function ()
    Prefs.getInt("font.size.variable.x-western")
  ,

  tweakFonts: function (iframeDoc) {
    if (!Prefs.tweak_bodies)
      return;

    let baseSize = isOSX ? 15 : 16;
    let textSize = Math.round(100 * this.defaultSize * 12 / baseSize) / 100;

    // Assuming 16px is the default (like on, say, Linux), this gives
    //  18px and 12px, which what Andy had in mind.
    // We're applying the style at the beginning of the <head> tag and
    //  on the body element so that it can be easily overridden by the
    //  html.
    // This is for HTML messages only.
    let styleRules = [];
    if (iframeDoc.querySelectorAll(":not(.mimemail-body) > .moz-text-html").length) {
      styleRules = [
        "body {",
        //"  line-height: 112.5%;",
        "  font-size: "+textSize+"px;",
        "}",
      ];
    }

    // Unless the user specifically asked for this message to be
    //  dislayed with a monospaced font...
    let [{name, email}] = this.parse(this._msgHdr.mime2DecodedAuthor);
    if (!(email in Prefs["monospaced_senders"]) &&
        !(this.mailingLists.some(function (x) (x in Prefs["monospaced_senders"])))) {
      styleRules = styleRules.concat([
        ".moz-text-flowed, .moz-text-plain {",
        "  font-family: \""+Prefs.getChar("font.default")+"\" !important;",
        "  font-size: "+textSize+"px !important;",
        "  line-height: 112.5% !important;",
        "}",
      ]);
    }

    // Do some reformatting + deal with people who have bad taste. All these
    // rules are important: some people just send messages with horrible colors,
    // which ruins the conversation view. Gecko tends to automatically add
    // padding/margin to html mails.
    styleRules = styleRules.concat([
      "body {",
      "  margin: 0; padding: 0;",
      "  color: rgb(10, 10, 10); background-color: transparent;",
      "}",
    ]);

    // Ugly hack (once again) to get the style inside the
    // <iframe>. I don't think we can use a chrome:// url for
    // the stylesheet because the iframe has a type="content"
    let style = iframeDoc.createElement("style");
    style.appendChild(iframeDoc.createTextNode(styleRules.join("\n")));
    let head = iframeDoc.body.previousElementSibling;
    if (head.firstChild)
      head.insertBefore(style, head.firstChild);
    else
      head.appendChild(style);
  },

  detectQuotes: function (iframe) {
    let baseSize = isOSX ? 15 : 16;
    let smallSize = Prefs.tweak_chrome
      ? Math.round(100 * this.defaultSize * 11 / baseSize) / 100
      : Math.round(100 * this.defaultSize * 11 / 12) / 100;

    // Launch various crappy pieces of code^W^W^W^W heuristics to
    //  convert most common quoting styles to real blockquotes. Spoiler:
    //  most of them suck.
    let self = this;
    let iframeDoc = iframe.contentDocument;
    try {
      let t = Date.now();
      let log = function () {
        let t1 = Date.now();
        let delta = t1 - t;
        let args = [x for each ([, x] in Iterator(arguments))];
        Log.debug.apply(Log, args.concat([delta+"ms"]));
        t = Date.now();
      };
      convertOutlookQuotingToBlockquote(iframe.contentWindow, iframeDoc);
      //log("convertOutlookQuotingToBlockquote");
      convertHotmailQuotingToBlockquote1(iframeDoc);
      //log("convertHotmailQuotingToBlockquote1");
      convertHotmailQuotingToBlockquote2(iframe.contentWindow, iframeDoc, Prefs["hide_quote_length"]);
      //log("convertHotmailQuotingToBlockquote2");
      convertForwardedToBlockquote(iframeDoc);
      //log("convertForwardedToBlockquote");
      fusionBlockquotes(iframeDoc);
      //log("fusionBlockquotes");
    } catch (e) {
      Log.warn(e);
      dumpCallStack(e);
    }
    // this function adds a show/hide quoted text link to every topmost
    // blockquote. Nested blockquotes are not taken into account.
    let walk = function walk_ (elt) {
      for (let i = elt.childNodes.length - 1; i >= 0; --i) {
        let c = elt.childNodes[i];
        // GMail uses class="gmail_quote", other MUAs use type="cite"...
        // so just search for a regular blockquote
        if (c.tagName && c.tagName.toLowerCase() == "blockquote") {
          if (c.getUserData("hideme") !== false) { // null is ok, true is ok too
            // Compute the approximate number of lines while the element is still visible
            let style;
            try {
              style = iframe.contentWindow.getComputedStyle(c, null);
            } catch (e) {
              // message arrived and window is not displayed, arg,
              // cannot get the computed style, BAD
            }
            if (style) {
              let numLines = parseInt(style.height) / parseInt(style.lineHeight);
              if (numLines > Prefs["hide_quote_length"]) {
                let showText = strings.get("showQuotedText");
                let hideText = strings.get("hideQuotedText");
                let div = iframeDoc.createElement("div");
                div.setAttribute("class", "link showhidequote");
                div.addEventListener("click", function div_listener (event) {
                  let h = self._conversation._htmlPane.contentWindow.toggleQuote(event, showText, hideText);
                  iframe.style.height = (parseFloat(iframe.style.height) + h)+"px";
                }, true);
                div.setAttribute("style", "color: orange; cursor: pointer; font-size: "+smallSize+"px;");
                div.appendChild(iframeDoc.createTextNode("- "+showText+" -"));
                elt.insertBefore(div, c);
                c.style.display = "none";
              }
            }
          }
        } else {
          walk(c);
        }
      }
    };
    // https://github.com/protz/GMail-Conversation-View/issues#issue/179
    // See link above for a rationale ^^
    if (self.initialPosition > 0)
      walk(iframeDoc);
  },

  /**
   * The phishing detector that's in Thunderbird would need a lot of rework:
   * it's not easily extensible, and the code has a lot of noise, i.e. it just
   * performs simple operations but it's written in a convoluted way. We should
   * just rewrite everything, but for now, we just rewrite+simplify the main
   * function, and still rely on the badly-designed underlying functions for the
   * low-level treatments.
   */
  checkForFishing: function (iframeDoc) {
    if (!Prefs.getBool("mail.phishing.detection.enabled"))
      return false;

    let gPhishingDetector = topMail3Pane(this).gPhishingDetector;
    let isPhishing = false;
    let links = iframeDoc.getElementsByTagName("a");
    for (let [, a] in Iterator(links)) {
      let linkText = a.textContent;
      let linkUrl = a.getAttribute("href");
      let hrefURL;
      // make sure relative link urls don't make us bail out
      try {
        hrefURL = Services.io.newURI(linkUrl, null, null);
      } catch(ex) {
        continue;
      }

      // only check for phishing urls if the url is an http or https link.
      // this prevents us from flagging imap and other internally handled urls
      if (hrefURL.schemeIs('http') || hrefURL.schemeIs('https')) {
        // The link is not suspicious if the visible text is the same as the URL,
        // even if the URL is an IP address. URLs are commonly surrounded by
        // < > or "" (RFC2396E) - so strip those from the link text before comparing.
        if (linkText)
          linkText = linkText.replace(/^<(.+)>$|^"(.+)"$/, "$1$2");

        let failsStaticTests = false;
        if (linkText != linkUrl) {
          // Yes, the third parameter to misMatchedHostWithLinkText is actually
          //  required, but it's some kind of an out value that's useless for
          //  us, so just pass it {} so that it's happy...
          let unobscuredHostNameValue = gPhishingDetector.hostNameIsIPAddress(hrefURL.host);
          failsStaticTests =
            unobscuredHostNameValue
              && !gPhishingDetector.isLocalIPAddress(unobscuredHostNameValue)
            || linkText
              && gPhishingDetector.misMatchedHostWithLinkText(hrefURL, linkText, {});
        }

        if (failsStaticTests) {
          Log.debug("Suspicious link", linkUrl);
          isPhishing = true;
          break;
        }
      }
    }
    return isPhishing;
  },
};

MixIn(Message, PostStreamingFixesMixIn);
