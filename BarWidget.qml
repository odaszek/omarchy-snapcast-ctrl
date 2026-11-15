import QtQuick
import QtQuick.Controls
import Quickshell
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "components"
import "lib/model.mjs" as Model

// Bar icon + Snapcast panel. One instance per bar/screen; all state lives in
// Service.qml. The panel mirrors SnapWeb: a card per group (stream, transport,
// now playing, group volume) with its clients, plus pages for group settings,
// client details, streams, adding a stream, and settings.
Panel {
  id: root
  moduleName: "odach.snapcast-ctrl"
  manageIpc: false

  property var service: null
  readonly property bool ready: service !== null
  readonly property var cfg: ready ? service.settings : Model.normalizeSettings({})

  // ---- theme ----
  readonly property color fg: bar ? bar.foreground : Commons.Color.foreground
  readonly property color dim: Qt.darker(fg, 1.55)
  readonly property color accent: Commons.Color.accent
  readonly property color urgent: bar ? bar.urgent : Commons.Color.urgent
  readonly property color panelBackground: Commons.Color.popups.background
  readonly property color subtle: Util.alpha(fg, 0.06)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  // ---- navigation ----
  // "main" | "group" | "client" | "streams" | "addStream" | "settings"
  property string page: "main"
  property string pageArg: ""
  property var history: []
  // True while a text field in a page has focus: keys go to the field.
  property bool editing: false

  // ---- confirmation dialog ----
  property bool confirmOpen: false
  property string confirmMessage: ""
  property string confirmText: ""
  property var confirmAction: null

  Commons.Translations {
    id: translations
    directory: Qt.resolvedUrl("i18n")
  }
  readonly property alias strings: translations

  Timer {
    interval: 250
    repeat: true
    running: root.service === null
    triggeredOnStart: true
    onTriggered: {
      var api = root.bar ? root.bar.shell : null
      if (api && typeof api.serviceFor === "function") root.service = api.serviceFor(root.moduleName)
    }
  }

  onOpenedChanged: {
    if (opened) {
      // First open with no server configured goes straight to settings.
      if (ready && !service.configured) go("settings", "", true)
    } else {
      confirmOpen = false
      editing = false
    }
  }

  function go(name, arg, reset) {
    if (reset) history = []
    else if (page !== name || pageArg !== (arg || "")) history = history.concat([{ page: page, arg: pageArg }])
    // pageArg first: the page's Loader builds the new page as soon as `page` changes.
    pageArg = arg || ""
    page = name
    editing = false
    if (panel.loadedContent) panel.loadedContent.scrollToTop()
  }

  function back() {
    if (confirmOpen) {
      confirmOpen = false
      return
    }
    if (history.length === 0) {
      if (page === "main") close()
      else go("main", "", true)
      return
    }
    var prev = history[history.length - 1]
    history = history.slice(0, history.length - 1)
    pageArg = prev.arg
    page = prev.page
    editing = false
  }

  function confirm(message, buttonText, action) {
    confirmMessage = message
    confirmText = buttonText
    confirmAction = action
    confirmOpen = true
  }

  readonly property string barTooltip: {
    if (!ready) return ""
    if (!service.configured) return strings.t("tooltip.unconfigured")
    if (!service.connected) return strings.t("tooltip.disconnected").arg(service.settings.host)
    var g = service.targetGroup
    if (!g) return strings.t("tooltip.connected").arg(service.settings.host)
    return strings.t("tooltip.group").arg(Model.neutralize(Model.groupName(g)))
      .arg(Commons.I18n.formatNumber(Math.round(Model.groupVolume(g, true))))
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: Model.barIcon(root.ready && root.service.connected, root.ready && root.service.playing)
    active: root.ready && root.service.localRunning
    tooltipText: root.opened ? "" : root.barTooltip
    onPressed: function(b) {
      if (b === Qt.LeftButton || b === Qt.RightButton) root.toggle()
      else if (b === Qt.MiddleButton && root.ready) root.service.setLocalPlayback(!root.service.localOn)
    }
    onWheelMoved: function(delta) {
      if (!root.ready) return
      root.service.nudgeVolume(delta > 0 ? 1 : -1)
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened && root.ready
    focusTarget: panel.loadedContent
    contentWidth: panel.fittedContentWidth(Style.space(root.cfg.popupWidth))
    contentHeight: panel.fittedContentHeight(panel.loadedContentHeight, Style.space(root.cfg.popupMaxHeight))

    content: PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      blocked: root.editing || root.confirmOpen
      // Natural height (not column.implicitHeight: the scroll area's height
      // depends on the panel height, which follows this value).
      implicitHeight: header.implicitHeight + pageLoader.implicitHeight + Style.space(4)
        + (banner.visible ? banner.implicitHeight + column.spacing : 0)
        + (footer.visible ? footer.implicitHeight + column.spacing : 0) + column.spacing

      function scrollToTop() { scroll.contentItem.contentY = 0 }

      onMoveRequested: function(dx, dy) {
        var f = scroll.contentItem
        if (dy !== 0) f.contentY = Math.max(0, Math.min(f.contentHeight - f.height, f.contentY + dy * Style.space(60)))
        else if (dx !== 0 && root.page === "main") root.service.nudgeVolume(dx)
      }
      onCloseRequested: root.back()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      // Single-key shortcuts (documented in the README).
      onTextKey: function(t) {
        var k = t.toLowerCase()
        if (k === "s") root.go("settings")
        else if (k === "t" && root.service.connected) root.go("streams")
        else if (k === "n" && root.service.connected) root.go("addStream")
        else if (k === "g" && root.service.targetGroup) root.go("group", root.service.targetGroup.id)
        else if (k === "r") root.service.reconnect()
        else if (k === "p") root.service.setLocalPlayback(!root.service.localOn)
        else if (k === "m" && root.service.targetGroup) root.service.setGroupMute(root.service.targetGroup.id, !root.service.targetGroup.muted)
      }

      Column {
        id: column
        anchors.fill: parent
        spacing: Style.space(10)

        PanelHeader {
          id: header
          app: root
          width: parent.width
        }

        ConnectionBanner {
          id: banner
          app: root
          width: parent.width
        }

        ScrollView {
          id: scroll
          width: parent.width
          height: Math.max(0, Math.min(pageLoader.implicitHeight + Style.space(4),
            keyCatcher.height - header.height - column.spacing
              - (footer.visible ? footer.height + column.spacing : 0)
              - (banner.visible ? banner.height + column.spacing : 0)))
          clip: true
          ScrollBar.horizontal.policy: ScrollBar.AlwaysOff
          ScrollBar.vertical.policy: pageLoader.implicitHeight > height ? ScrollBar.AsNeeded : ScrollBar.AlwaysOff
          contentWidth: availableWidth
          Binding {
            target: scroll.contentItem
            property: "interactive"
            value: pageLoader.implicitHeight > scroll.height
          }

          Loader {
            id: pageLoader
            width: scroll.availableWidth
            sourceComponent: {
              switch (root.page) {
              case "group": return groupPage
              case "client": return clientPage
              case "streams": return streamsPage
              case "addStream": return addStreamPage
              case "settings": return settingsPage
              default: return mainPage
              }
            }
          }
        }

        PanelFooter {
          id: footer
          app: root
          width: parent.width
        }
      }

      ConfirmDialog {
        id: confirmDialog
        anchors.fill: parent
        z: 10
        opened: root.confirmOpen
        focus: opened
        onOpenedChanged: opened ? forceActiveFocus() : keyCatcher.forceActiveFocus()
        Keys.onPressed: function(event) { if (handleKey(event)) event.accepted = true }
        message: root.confirmMessage
        confirmText: root.confirmText
        cancelText: root.strings.t("common.cancel")
        background: root.panelBackground
        foreground: root.fg
        fontFamily: root.fontFamily
        onCanceled: root.confirmOpen = false
        onConfirmed: {
          root.confirmOpen = false
          var action = root.confirmAction
          root.confirmAction = null
          if (action) action()
        }
      }
    }
  }

  Component {
    id: mainPage
    MainPage { app: root }
  }
  Component {
    id: groupPage
    GroupPage { app: root; groupId: root.pageArg }
  }
  Component {
    id: clientPage
    ClientPage { app: root; clientId: root.pageArg }
  }
  Component {
    id: streamsPage
    StreamsPage { app: root }
  }
  Component {
    id: addStreamPage
    AddStreamPage { app: root }
  }
  Component {
    id: settingsPage
    SettingsPage { app: root }
  }
}
