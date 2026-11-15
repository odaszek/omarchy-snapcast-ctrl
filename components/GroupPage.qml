import QtQuick
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "../lib/model.mjs" as Model

// SnapWeb's "Group settings" dialog: stream, member clients (checkboxes for
// every client on the server), plus the group name (Snapdroid), playback
// options the stream supports, and "Play here" for this computer.
Column {
  id: root
  property var app: null
  property string groupId: ""
  readonly property var service: app ? app.service : null
  readonly property var group: service ? Model.findGroup(service.server, groupId) : null
  readonly property var stream: group ? Model.findStream(service.server, group.stream_id) : null
  readonly property var props: stream ? stream.properties : null

  // Edited copy; applied on OK like SnapWeb.
  property string name: ""
  property string streamId: ""
  property var members: ({})
  property var allClients: []
  property bool busy: false

  spacing: Style.space(12)

  property bool initialized: false
  Component.onCompleted: reset()
  onGroupChanged: if (!initialized) reset()
  function reset() {
    if (!group) return
    initialized = true
    name = group.name
    streamId = group.stream_id
    var m = {}
    for (var i = 0; i < group.clients.length; i++) m[group.clients[i].id] = true
    members = m
    allClients = Model.allClients(service.server)
  }

  function memberIds() {
    var out = []
    for (var i = 0; i < allClients.length; i++) if (members[allClients[i].id]) out.push(allClients[i].id)
    return out
  }

  function apply() {
    if (!group) {
      app.back()
      return
    }
    var ids = memberIds()
    var before = group.clients.map(function(c) { return c.id }).sort().join("\n")
    var steps = []
    if (name.trim() !== group.name) steps.push(function(next) { service.setGroupName(groupId, name.trim(), next) })
    if (streamId !== group.stream_id) steps.push(function(next) { service.setGroupStream(groupId, streamId, next) })
    // Membership last: it can dissolve this group.
    if (ids.slice().sort().join("\n") !== before) steps.push(function(next) { service.setGroupClients(groupId, ids, next) })
    busy = true
    var run = function() {
      if (steps.length === 0) {
        busy = false
        app.back()
        return
      }
      steps.shift()(function() { run() })
    }
    run()
  }

  PlainText {
    width: parent.width
    visible: !root.group
    text: root.app.strings.t("group.gone")
    color: root.app.dim
    font.family: root.app.fontFamily
    font.pixelSize: Style.font.body
  }

  FormField {
    width: parent.width
    visible: !!root.group
    app: root.app
    label: root.app.strings.t("group.name")
    hint: root.app.strings.t("group.nameHint")
    Field {
      app: root.app
      text: root.name
      maximumLength: 128
      placeholderText: Model.groupName(root.group)
      onTextChanged: root.name = text
    }
  }

  FormField {
    width: parent.width
    visible: !!root.group
    app: root.app
    label: root.app.strings.t("group.stream")
    Dropdown {
      width: parent.width
      showLabel: false
      value: root.streamId
      options: root.service ? root.service.server.streams.map(function(s) { return { value: s.id, label: Model.neutralize(s.id) + " · " + root.app.strings.t("stream.status." + s.status, s.status) } }) : []
      foreground: root.app.fg
      background: root.app.panelBackground
      fontFamily: root.app.fontFamily
      onChanged: function(v) { root.streamId = v }
    }
  }

  PanelSectionHeader {
    visible: !!root.group
    text: root.app.strings.t("group.clients")
    foreground: root.app.fg
    fontFamily: root.app.fontFamily
  }

  Column {
    width: parent.width
    visible: !!root.group
    spacing: Style.space(4)
    Repeater {
      model: root.allClients
      Toggle {
        required property var modelData
        width: root.width
        label: Model.neutralize(Model.clientName(modelData))
        description: (modelData.connected ? root.app.strings.t("client.online") : root.app.strings.t("client.offline"))
          + (modelData.id === root.service.localClientId ? " · " + root.app.strings.t("client.thisDevice") : "")
        checked: root.members[modelData.id] === true
        foreground: root.app.fg
        fontFamily: root.app.fontFamily
        titleSize: Style.font.body
        onClicked: {
          var m = Object.assign({}, root.members)
          if (m[modelData.id]) delete m[modelData.id]
          else m[modelData.id] = true
          root.members = m
        }
      }
    }
  }

  // "Play here": put this computer's client into the group (starting local playback if needed).
  Button {
    visible: !!root.group && root.service.configured && root.service.localClientId !== ""
      && !root.group.clients.some(function(c) { return c.id === root.service.localClientId })
      && Model.findClient(root.service.server, root.service.localClientId) !== null
    text: root.app.strings.t("group.playHere")
    iconText: Model.ICON.laptop
    focusable: true
    bordered: true
    foreground: root.app.fg
    fontFamily: root.app.fontFamily
    onClicked: {
      var m = Object.assign({}, root.members)
      m[root.service.localClientId] = true
      root.members = m
    }
  }

  // ---- playback options the stream supports ----
  PanelSectionHeader {
    visible: root.props !== null && root.props.canControl
    text: root.app.strings.t("group.playback")
    foreground: root.app.fg
    fontFamily: root.app.fontFamily
  }

  Toggle {
    width: parent.width
    visible: root.props !== null && root.props.canControl
    label: root.app.strings.t("playback.shuffle")
    checked: root.props ? root.props.shuffle : false
    foreground: root.app.fg
    fontFamily: root.app.fontFamily
    titleSize: Style.font.body
    onClicked: root.service.streamSetProperty(root.stream.id, "shuffle", !root.props.shuffle)
  }

  FormField {
    width: parent.width
    visible: root.props !== null && root.props.canControl
    app: root.app
    label: root.app.strings.t("playback.loop")
    ButtonGroup {
      width: parent.width
      options: [
        { value: "none", label: root.app.strings.t("playback.loopNone") },
        { value: "track", label: root.app.strings.t("playback.loopTrack") },
        { value: "playlist", label: root.app.strings.t("playback.loopPlaylist") }
      ]
      value: root.props ? root.props.loopStatus : "none"
      foreground: root.app.fg
      background: root.app.panelBackground
      fontFamily: root.app.fontFamily
      onChanged: function(v) { root.service.streamSetProperty(root.stream.id, "loopStatus", v) }
    }
  }

  Row {
    visible: root.props !== null && root.props.canControl && root.props.canSeek
    spacing: Style.space(8)
    Button {
      text: root.app.strings.t("playback.back10")
      focusable: true
      foreground: root.app.fg
      fontFamily: root.app.fontFamily
      onClicked: root.service.streamControl(root.stream.id, "seek", { offset: -10 })
    }
    Button {
      text: root.app.strings.t("playback.forward10")
      focusable: true
      foreground: root.app.fg
      fontFamily: root.app.fontFamily
      onClicked: root.service.streamControl(root.stream.id, "seek", { offset: 10 })
    }
    PlainText {
      anchors.verticalCenter: parent.verticalCenter
      text: root.props ? Commons.I18n.formatNumber(Math.floor(root.props.position / 60)) + ":"
        + ("0" + Math.floor(root.props.position % 60)).slice(-2) : ""
      color: root.app.dim
      font.family: root.app.fontFamily
      font.pixelSize: Style.font.caption
    }
  }

  ActionRow {
    width: parent.width
    visible: !!root.group
    app: root.app
    busy: root.busy
    onCancel: root.app.back()
    onOk: root.apply()
  }
}
