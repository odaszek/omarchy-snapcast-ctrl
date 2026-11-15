import QtQuick
import qs.Commons
import qs.Ui
import "../lib/model.mjs" as Model

// Connection problems (SnapWeb's error snackbar): not configured, connecting,
// disconnected with the server's error, helper failures, local player errors.
Item {
  id: root
  property var app: null
  readonly property var service: app ? app.service : null
  readonly property string message: {
    if (!service) return ""
    if (service.helperError !== "") return service.helperError
    if (!service.configured) return app.strings.t("banner.unconfigured")
    if (service.connectionState === "connecting" && service.connectionError === "") return app.strings.t("banner.connecting").arg(service.settings.host)
    if (service.connectionState === "disconnected" || (service.connectionState === "connecting" && service.connectionError !== ""))
      return app.strings.t("banner.disconnected").arg(service.settings.host + ":" + service.settings.port).arg(service.connectionError)
    if (service.local.state === "unavailable" && service.settings.localPlayback) return app.strings.t("banner.noSnapclient")
    if ((service.local.state === "error" || service.local.state === "restarting") && service.local.error !== "")
      return app.strings.t("banner.localError").arg(service.local.error)
    return ""
  }
  readonly property bool problem: service && (service.helperError !== "" || service.connectionState === "disconnected"
    || service.local.state === "error" || service.local.state === "restarting" || (service.local.state === "unavailable" && service.settings.localPlayback))

  visible: message !== "" && (!app || app.page !== "settings" || service.helperError !== "")
  implicitHeight: visible ? box.implicitHeight : 0

  Rectangle {
    id: box
    width: parent.width
    implicitHeight: row.implicitHeight + Style.space(16)
    radius: Style.cornerRadius
    color: root.problem ? Util.alpha(root.app.urgent, 0.14) : root.app.subtle

    Row {
      id: row
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(10)
      anchors.rightMargin: Style.space(6)
      spacing: Style.space(8)

      PlainText {
        width: parent.width - (retry.visible ? retry.width + parent.spacing : 0)
        anchors.verticalCenter: parent.verticalCenter
        text: root.message
        wrapMode: Text.Wrap
        maximumLineCount: 4
        color: root.problem ? root.app.urgent : root.app.fg
        font.family: root.app.fontFamily
        font.pixelSize: Style.font.bodySmall
      }

      IconButton {
        id: retry
        app: root.app
        anchors.verticalCenter: parent.verticalCenter
        visible: root.service && root.service.configured && root.service.connectionState !== "connected"
        iconText: Model.ICON.retry
        tooltipText: root.app.strings.t("banner.retry")
        onClicked: root.service.reconnect()
      }
    }
  }
}
