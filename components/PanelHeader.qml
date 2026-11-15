import QtQuick
import qs.Commons
import "../lib/model.mjs" as Model

// Title row: back (on sub-pages), page title, and SnapWeb's app-bar actions:
// play/stop on this computer, streams, settings.
Item {
  id: root
  property var app: null
  readonly property var service: app ? app.service : null
  readonly property string title: {
    if (!app) return ""
    switch (app.page) {
    case "group": return app.strings.t("group.title")
    case "client": return app.strings.t("client.title")
    case "streams": return app.strings.t("streams.title")
    case "addStream": return app.strings.t("addStream.title")
    case "settings": return app.strings.t("settings.title")
    default: return app.strings.t("panel.title")
    }
  }

  implicitHeight: Math.max(titleText.implicitHeight, actions.implicitHeight)

  IconButton {
    id: backButton
    app: root.app
    visible: root.app && root.app.page !== "main"
    anchors.left: parent.left
    anchors.verticalCenter: parent.verticalCenter
    iconText: Model.ICON.back
    tooltipText: root.app ? root.app.strings.t("common.back") : ""
    onClicked: root.app.back()
  }

  PlainText {
    id: titleText
    anchors.left: backButton.visible ? backButton.right : parent.left
    anchors.leftMargin: backButton.visible ? Style.space(8) : 0
    anchors.right: actions.left
    anchors.rightMargin: Style.space(8)
    anchors.verticalCenter: parent.verticalCenter
    text: root.title
    color: root.app ? root.app.fg : "white"
    font.family: root.app ? root.app.fontFamily : Style.font.family
    font.pixelSize: Style.font.title
    font.bold: true
  }

  Row {
    id: actions
    anchors.right: parent.right
    anchors.verticalCenter: parent.verticalCenter
    spacing: Style.space(4)
    visible: root.app && root.app.page === "main"

    IconButton {
      app: root.app
      visible: root.service && root.service.configured
      iconText: root.service && root.service.settings.localPlayback ? Model.ICON.stop : Model.ICON.play
      hoverColor: root.app ? root.app.accent : "white"
      tooltipText: root.app ? (root.service && root.service.settings.localPlayback
        ? root.app.strings.t("header.stopLocal") : root.app.strings.t("header.playLocal")) : ""
      onClicked: root.service.setLocalPlayback(!root.service.settings.localPlayback)
    }
    IconButton {
      app: root.app
      enabled: root.service && root.service.connected
      iconText: Model.ICON.streams
      tooltipText: root.app ? root.app.strings.t("header.streams") : ""
      onClicked: root.app.go("streams")
    }
    IconButton {
      app: root.app
      iconText: Model.ICON.settings
      tooltipText: root.app ? root.app.strings.t("header.settings") : ""
      onClicked: root.app.go("settings")
    }
  }
}
