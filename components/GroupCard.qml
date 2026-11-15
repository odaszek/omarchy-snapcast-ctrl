import QtQuick
import qs.Commons
import qs.Ui
import "../lib/model.mjs" as Model

// One Snapcast group, laid out like SnapWeb's Group card:
//   [settings] [stream ▾]            [⏮ ⏯ ⏭]
//   [art] title / artist
//   [mute] ───────── group volume ─────────     (when > 1 client)
//   ─────────────────────────────────────────
//   client rows
Rectangle {
  id: root
  property var app: null
  property string groupId: ""
  readonly property var service: app ? app.service : null
  readonly property var group: service ? Model.findGroup(service.server, groupId) : null
  readonly property var stream: group && service ? Model.findStream(service.server, group.stream_id) : null
  readonly property var controls: Model.controls(stream)
  readonly property var meta: stream && stream.properties.metadata ? stream.properties.metadata : null
  readonly property bool hideOffline: service ? service.settings.hideOffline : false
  readonly property var shownClients: Model.visibleClients(group, hideOffline)
  readonly property string localId: service ? service.localClientId : ""
  readonly property bool hasLocal: localId !== "" && shownClients.some(function(c) { return c.id === localId })

  // Client ids, reassigned only when membership changes so rows (and a
  // slider being dragged) survive volume updates.
  property var clientIds: []
  onShownClientsChanged: {
    var ids = shownClients.map(function(c) { return c.id })
    if (ids.join("\n") !== clientIds.join("\n")) clientIds = ids
  }
  Component.onCompleted: clientIds = shownClients.map(function(c) { return c.id })

  // Group volume drag: SnapWeb snapshots the client volumes when a drag begins.
  property var dragStart: []
  readonly property real groupVolume: Model.groupVolume(group, hideOffline)

  radius: Style.cornerRadius
  color: app ? app.subtle : "transparent"
  border.width: hasLocal ? Math.max(1, Style.space(1)) : 0
  border.color: app ? Util.alpha(app.accent, 0.6) : "transparent"
  implicitHeight: content.implicitHeight + Style.space(20)

  Column {
    id: content
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.top: parent.top
    anchors.margins: Style.space(10)
    spacing: Style.space(8)

    // ---- group name ----
    Item {
      width: parent.width
      implicitHeight: nameText.implicitHeight
      PlainText {
        id: nameText
        anchors.left: parent.left
        anchors.right: statusText.left
        anchors.rightMargin: Style.space(8)
        text: Model.groupName(root.group)
        color: root.app.fg
        font.family: root.app.fontFamily
        font.pixelSize: Style.font.subtitle
        font.bold: true
      }
      PlainText {
        id: statusText
        anchors.right: parent.right
        anchors.verticalCenter: nameText.verticalCenter
        text: root.stream ? root.app.strings.t("stream.status." + root.stream.status, root.stream.status) : ""
        color: root.stream && root.stream.status === "playing" ? root.app.accent : root.app.dim
        font.family: root.app.fontFamily
        font.pixelSize: Style.font.caption
      }
    }

    // ---- settings · stream · transport ----
    Item {
      width: parent.width
      implicitHeight: Math.max(streamSelect.implicitHeight, transport.implicitHeight)

      IconButton {
        id: settingsButton
        app: root.app
        anchors.left: parent.left
        anchors.verticalCenter: parent.verticalCenter
        iconText: Model.ICON.settings
        tooltipText: root.app.strings.t("group.settings")
        onClicked: root.app.go("group", root.groupId)
      }

      Dropdown {
        id: streamSelect
        anchors.left: settingsButton.right
        anchors.leftMargin: Style.space(6)
        anchors.right: transport.left
        anchors.rightMargin: Style.space(6)
        anchors.verticalCenter: parent.verticalCenter
        showLabel: false
        value: root.group ? root.group.stream_id : ""
        options: root.service ? root.service.server.streams.map(function(s) { return { value: s.id, label: Model.neutralize(s.id) } }) : []
        foreground: root.app.fg
        background: root.app.panelBackground
        fontFamily: root.app.fontFamily
        onChanged: function(v) { if (root.group && v !== root.group.stream_id) root.service.setGroupStream(root.groupId, v) }
      }

      Row {
        id: transport
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(2)
        visible: root.controls.any

        IconButton {
          app: root.app
          enabled: root.controls.previous
          iconText: Model.ICON.previous
          tooltipText: root.app.strings.t("transport.previous")
          onClicked: root.service.streamControl(root.stream.id, "previous")
        }
        IconButton {
          app: root.app
          enabled: root.controls.playPause
          iconText: root.controls.playing ? Model.ICON.pause : Model.ICON.play
          tooltipText: root.controls.playing ? root.app.strings.t("transport.pause") : root.app.strings.t("transport.play")
          onClicked: root.service.playPause(root.stream.id)
        }
        IconButton {
          app: root.app
          enabled: root.controls.next
          iconText: Model.ICON.next
          tooltipText: root.app.strings.t("transport.next")
          onClicked: root.service.streamControl(root.stream.id, "next")
        }
      }
    }

    // ---- now playing ----
    NowPlaying {
      width: parent.width
      app: root.app
      stream: root.stream
      visible: root.service && root.service.settings.showMetadata && root.meta !== null
        && (root.meta.title !== "" || root.meta.artist.length > 0)
    }

    // ---- group volume (SnapWeb shows it only for more than one client) ----
    VolumeRow {
      width: parent.width
      app: root.app
      visible: root.clientIds.length > 1
      muted: root.group ? root.group.muted : false
      value: root.groupVolume
      muteTooltip: root.app.strings.t("group.mute")
      onMuteToggled: root.service.setGroupMute(root.groupId, !root.group.muted)
      onDragStarted: root.dragStart = Model.volumeSnapshot(root.group, root.hideOffline)
      onMoved: function(v) {
        var start = root.dragStart.length > 0 ? root.dragStart : Model.volumeSnapshot(root.group, root.hideOffline)
        root.service.setVolumes(Model.groupVolumeTargets(start, v))
      }
      onReleased: root.dragStart = []
    }

    PanelSeparator {
      foreground: root.app.fg
    }

    Repeater {
      model: root.clientIds

      ClientRow {
        required property string modelData
        width: content.width
        app: root.app
        clientId: modelData
      }
    }
  }
}
