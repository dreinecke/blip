import QtQuick
import QtQuick.Controls as QQC
import QtQuick.Layouts
import QtQuick.Shapes
import qs.Commons
import qs.Ui

// In-app appearance editor. Changes apply immediately through the shared
// BlipPreferences object and are debounced to ~/.config/blip/preferences.json.
FocusScope {
  id: root

  property var preferences: null
  property color foreground: Color.foreground
  property color urgent: Color.urgent
  property color accent: Color.accent
  property color outgoingFill: accent
  property color outgoingText: "#ffffff"
  property color incomingFill: Qt.rgba(foreground.r, foreground.g, foreground.b, 0.14)
  property color incomingText: foreground
  property string fontFamily: Style.font.family
  property real fontScale: 1.0
  property real density: 1.0
  property real cornerScale: 1.0
  property var hostWidget: null
  property string localError: ""
  property bool resetArmed: false
  property string page: "appearance"
  // The popout matches this width while settings are showing: the appearance
  // workspace needs it for preview-beside-controls (two-column at space(700),
  // with headroom that absorbs the panel's fixed padding at every density).
  readonly property real wideWidth: space(980)
  readonly property bool editorActive: outgoingSetting.editorActive || incomingSetting.editorActive

  // The page's own chrome must not re-lay-out while the user drags an
  // appearance slider — only the live preview tracks the moving values.
  // Chrome scales are frozen each time settings opens.
  property real chromeFontScale: 1.0
  property real chromeDensity: 1.0
  property real chromeCornerScale: 1.0
  function freezeChrome() {
    chromeFontScale = fontScale
    chromeDensity = density
    chromeCornerScale = cornerScale
  }
  onVisibleChanged: if (visible) freezeChrome()
  Component.onCompleted: freezeChrome()

  signal closeRequested()

  function fontSize(value) { return Math.max(1, Math.round(value * chromeFontScale)) }
  function space(value) { return Math.max(1, Math.round(Style.spaceReal(value) * chromeDensity)) }
  function corner(value) { return Math.max(0, Math.round(value * chromeCornerScale)) }
  function liveFontSize(value) { return Math.max(1, Math.round(value * fontScale)) }
  function liveSpace(value) { return Math.max(1, Math.round(Style.spaceReal(value) * density)) }
  function liveCorner(value) { return Math.max(0, Math.round(value * cornerScale)) }
  function focusDefault() { forceActiveFocus() }
  function showPage(value) {
    page = "appearance"
    settingsFlick.contentY = 0
  }

  Keys.onEscapePressed: root.closeRequested()

  ColumnLayout {
    anchors.fill: parent
    spacing: root.space(10)

    RowLayout {
      Layout.fillWidth: true
      PanelHero {
        Layout.fillWidth: true
        title: "Blip settings"
        meta: "Appearance"
        detail: ""
        foreground: root.foreground
        fontFamily: root.fontFamily
      }
      PanelActionButton {
        Layout.alignment: Qt.AlignTop
        focusable: true
        iconText: "×"
        tooltipText: "Close settings (Esc)"
        bordered: true
        foreground: root.foreground
        hoverColor: root.accent
        fontFamily: root.fontFamily
        fontSize: root.fontSize(Style.font.icon)
        onClicked: root.closeRequested()
      }
    }

    PanelSeparator { Layout.fillWidth: true; foreground: root.foreground }

    RowLayout {
      Layout.fillWidth: true
      spacing: root.space(8)
      ActionButton {
        label: "Appearance"
        selected: root.page === "appearance"
        onClicked: root.showPage("appearance")
      }
      Text {
        // fillWidth + elide: the popout is narrow, and an unbounded implicit
        // width here silently stretches the whole settings column past it.
        Layout.fillWidth: true
        horizontalAlignment: Text.AlignRight
        elide: Text.ElideRight
        text: "Changes preview and apply live"
        textFormat: Text.PlainText
        color: Qt.darker(root.foreground, 1.4)
        font.family: root.fontFamily
        font.pixelSize: root.fontSize(Style.font.caption)
      }
    }

    PanelSeparator { Layout.fillWidth: true; foreground: root.foreground }

    Flickable {
      id: settingsFlick
      Layout.fillWidth: true
      Layout.fillHeight: true
      contentWidth: width
      contentHeight: settingsContent.implicitHeight
      clip: true
      boundsBehavior: Flickable.StopAtBounds
      interactive: contentHeight > height
      QQC.ScrollBar.vertical: QQC.ScrollBar { policy: QQC.ScrollBar.AsNeeded }

      MouseArea {
        anchors.fill: parent
        z: -1
        acceptedButtons: Qt.NoButton
        onWheel: function(wheel) {
          var delta = wheel.pixelDelta.y !== 0 ? wheel.pixelDelta.y * 3.0 : wheel.angleDelta.y * 4.5
          var maximum = Math.max(0, settingsFlick.contentHeight - settingsFlick.height)
          settingsFlick.contentY = Math.max(0, Math.min(maximum, settingsFlick.contentY - delta))
          wheel.accepted = true
        }
      }

      ColumnLayout {
        id: settingsContent
        // Appearance uses the full window so the preview can be as large as
        // possible.
        width: parent.width
        anchors.horizontalCenter: parent.horizontalCenter
        spacing: root.space(16)

        ColumnLayout {
          Layout.fillWidth: true
          visible: root.page === "appearance"
          spacing: root.space(16)

        Text {
          Layout.fillWidth: true
          text: "Changes apply live. The files under ~/.config/blip can be tracked in dotfiles or restored later."
          textFormat: Text.PlainText
          wrapMode: Text.WordWrap
          color: Qt.darker(root.foreground, 1.35)
          font.family: root.fontFamily
          font.pixelSize: root.fontSize(Style.font.bodySmall)
        }

        GridLayout {
          id: appearanceWorkspace
          Layout.fillWidth: true
          // Preview-beside-controls whenever both columns can breathe. The
          // preview is a uniform-scale miniature, so it stays useful narrow;
          // keep this threshold well below the wide-popout width and the app
          // window's plausible sizes — space() shrinks with density while the
          // panel's padding does not, and a threshold close to the supplied
          // width flipped the popout back to stacked at low density.
          columns: width >= root.space(700) ? 2 : 1
          columnSpacing: root.space(24)
          rowSpacing: root.space(22)

          AppearancePreview {
            Layout.fillWidth: true
            Layout.minimumWidth: appearanceWorkspace.columns === 2 ? root.space(360) : 0
            Layout.alignment: Qt.AlignTop
          }

          ColumnLayout {
            // The controls pin to the right at a fixed measure; the preview
            // takes everything else.
            Layout.fillWidth: appearanceWorkspace.columns === 1
            Layout.minimumWidth: appearanceWorkspace.columns === 2 ? root.space(300) : 0
            Layout.preferredWidth: root.space(400)
            Layout.maximumWidth: appearanceWorkspace.columns === 2
              ? root.space(400) : Number.POSITIVE_INFINITY
            Layout.alignment: Qt.AlignTop
            spacing: root.space(14)

            PanelSectionHeader {
              Layout.fillWidth: true
              text: "COLORS"
              foreground: root.foreground
              fontFamily: root.fontFamily
              fontSize: root.fontSize(Style.font.caption)
            }

            ColorSetting {
              id: outgoingSetting
              Layout.fillWidth: true
              title: "Outgoing bubbles"
              preferenceKey: "outgoingBubbleColor"
              currentValue: root.preferences ? root.preferences.outgoingBubbleColor : "theme"
              resolvedColor: root.outgoingFill
            }

            ColorSetting {
              id: incomingSetting
              Layout.fillWidth: true
              title: "Incoming bubbles"
              preferenceKey: "incomingBubbleColor"
              currentValue: root.preferences ? root.preferences.incomingBubbleColor : "theme"
              resolvedColor: root.incomingFill
            }

            PanelSectionHeader {
              Layout.fillWidth: true
              text: "LAYOUT"
              foreground: root.foreground
              fontFamily: root.fontFamily
              fontSize: root.fontSize(Style.font.caption)
            }

            ColumnLayout {
              Layout.fillWidth: true
              spacing: root.space(5)
              Text {
                text: "Conversation list time"
                textFormat: Text.PlainText
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: root.fontSize(Style.font.bodySmall)
                font.bold: true
              }
              RowLayout {
                spacing: root.space(7)
                ActionButton {
                  label: "12-hour (AM/PM)"
                  selected: !root.preferences || root.preferences.use12HourConversationTimes
                  onClicked: if (root.preferences)
                    root.preferences.setBoolean("use12HourConversationTimes", true)
                }
                ActionButton {
                  label: "24-hour"
                  selected: root.preferences && !root.preferences.use12HourConversationTimes
                  onClicked: if (root.preferences)
                    root.preferences.setBoolean("use12HourConversationTimes", false)
                }
              }
            }

            PreferenceSlider {
              Layout.fillWidth: true
              title: "Window opacity"
              preferenceKey: "backgroundOpacity"
              currentValue: root.preferences ? root.preferences.backgroundOpacity : 0.70
              from: 0.20; to: 1.0; stepSize: 0.05; decimals: 0; multiplier: 100; suffix: "%"
            }
            PreferenceSlider {
              Layout.fillWidth: true
              title: "Font scale"
              preferenceKey: "fontScale"
              currentValue: root.preferences ? root.preferences.fontScale : 1.0
              from: 0.75; to: 1.50; stepSize: 0.05; decimals: 0; multiplier: 100; suffix: "%"
            }
            PreferenceSlider {
              Layout.fillWidth: true
              title: "Density"
              preferenceKey: "density"
              currentValue: root.preferences ? root.preferences.density : 1.0
              from: 0.70; to: 1.40; stepSize: 0.05; decimals: 0; multiplier: 100; suffix: "%"
            }
            PreferenceSlider {
              Layout.fillWidth: true
              title: "Sidebar width"
              preferenceKey: "sidebarWidth"
              currentValue: root.preferences ? root.preferences.sidebarWidth : 320
              from: 240; to: 520; stepSize: 10; decimals: 0; multiplier: 1; suffix: " px"
            }
            PreferenceSlider {
              Layout.fillWidth: true
              title: "Avatar size"
              preferenceKey: "avatarSize"
              currentValue: root.preferences ? root.preferences.avatarSize : 30
              from: 24; to: 64; stepSize: 2; decimals: 0; multiplier: 1; suffix: " px"
            }
            PreferenceSlider {
              Layout.fillWidth: true
              title: "Corner roundness"
              preferenceKey: "cornerScale"
              currentValue: root.preferences ? root.preferences.cornerScale : 1.0
              from: 0; to: 2.0; stepSize: 0.10; decimals: 1; multiplier: 1; suffix: "×"
            }

            Text {
              Layout.fillWidth: true
              visible: root.localError !== "" || (root.preferences && root.preferences.error !== "")
              text: root.localError !== "" ? root.localError : String(root.preferences ? root.preferences.error : "")
              textFormat: Text.PlainText
              wrapMode: Text.WordWrap
              color: root.urgent
              font.family: root.fontFamily
              font.pixelSize: root.fontSize(Style.font.caption)
            }

            Text {
              Layout.fillWidth: true
              text: root.preferences
                ? (root.preferences.saving ? "Saving…" : root.preferences.notice) + "\n" + root.preferences.configPath
                : "Preferences unavailable"
              textFormat: Text.PlainText
              wrapMode: Text.WrapAnywhere
              color: Qt.darker(root.foreground, 1.45)
              font.family: root.fontFamily
              font.pixelSize: root.fontSize(Style.font.caption)
            }

            RowLayout {
              Layout.fillWidth: true
              spacing: root.space(8)
              ActionButton {
                label: "Reload file"
                onClicked: {
                  root.resetArmed = false
                  root.localError = ""
                  if (root.preferences) root.preferences.load(true)
                }
              }
              Item { Layout.fillWidth: true }
              ActionButton {
                label: root.resetArmed ? "Confirm reset" : "Reset to defaults"
                danger: root.resetArmed
                onClicked: {
                  if (!root.resetArmed) {
                    root.resetArmed = true
                    return
                  }
                  root.resetArmed = false
                  root.localError = ""
                  if (root.preferences) root.preferences.restoreDefaults()
                }
              }
            }
          }
        }

        Item { Layout.preferredHeight: root.space(6) }
        }
      }
    }
  }

  // A uniformly scaled miniature of the real app window. Everything inside
  // previewWindow is laid out at REAL app dimensions — the raw-px sidebar,
  // spaceReal avatars, BlipWindow's edge inset — and shrunk by one scale
  // transform, so the preview is to scale instead of per-part approximations.
  component AppearancePreview: Rectangle {
    id: appearancePreview

    readonly property real opacityValue: root.preferences ? root.preferences.backgroundOpacity : 0.70
    readonly property int configuredSidebar: root.preferences ? root.preferences.sidebarWidth : 320
    readonly property int configuredAvatar: root.preferences ? root.preferences.avatarSize : 30
    // Mirrors BlipView: chronological rows use spaceReal(avatarSize); pinned
    // tiles use 1.75× with a space(48) floor.
    readonly property int rowAvatarSize: Math.max(1, Math.round(Style.spaceReal(configuredAvatar)))
    readonly property int pinAvatarSize: Math.max(
      Math.round(Style.spaceReal(configuredAvatar) * 1.75), root.liveSpace(48))
    // The miniature previews the app window's DEFAULT geometry (1040×720,
    // BlipWindow's implicit size) rather than the live window's. Mirroring
    // the live window made 100% structurally impossible — the card sits
    // inside that same window minus the controls column — while a fixed
    // reference reaches an honest, pixel-true 100% whenever the workspace
    // offers that much room, even in a modest window.
    readonly property real appWidth: 1040
    readonly property real appHeight: 720
    // Fit by width AND height so the whole miniature stays visible without
    // scrolling; never upscale past 100%.
    readonly property real previewScale: Math.max(0.05, Math.min(1,
      (width - root.space(24)) / appWidth,
      Math.max(root.space(220), root.height - root.space(250)) / appHeight))

    implicitHeight: previewColumn.implicitHeight + root.space(24)
    radius: root.corner(root.space(12))
    color: Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.06)
    border.width: 1
    border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.24)
    clip: true

    ColumnLayout {
      id: previewColumn
      anchors.fill: parent
      anchors.margins: root.space(12)
      spacing: root.space(9)

      RowLayout {
        Layout.fillWidth: true
        spacing: root.space(8)
        Text {
          text: "LIVE APP PREVIEW"
          textFormat: Text.PlainText
          color: root.accent
          font.family: root.fontFamily
          font.pixelSize: root.fontSize(Style.font.caption)
          font.bold: true
        }
        Text {
          // fillWidth + elide keeps the metrics from colliding with the
          // title when the preview column is narrow.
          Layout.fillWidth: true
          horizontalAlignment: Text.AlignRight
          elide: Text.ElideRight
          text: appearancePreview.configuredSidebar + " px sidebar · "
            + appearancePreview.configuredAvatar + " px avatars · "
            + Math.round(appearancePreview.previewScale * 100) + "% scale"
          textFormat: Text.PlainText
          color: Qt.darker(root.foreground, 1.4)
          font.family: root.fontFamily
          font.pixelSize: root.fontSize(Style.font.caption)
        }
      }

      Item {
        Layout.fillWidth: true
        Layout.preferredHeight: Math.round(appearancePreview.appHeight * appearancePreview.previewScale)

        Rectangle {
          id: previewWindow
          // centered when the height cap leaves spare width
          x: Math.round((parent.width
               - appearancePreview.appWidth * appearancePreview.previewScale) / 2)
          width: appearancePreview.appWidth
          height: appearancePreview.appHeight
          transformOrigin: Item.TopLeft
          scale: appearancePreview.previewScale
          radius: root.liveCorner(root.liveSpace(12))
          color: Qt.rgba(Color.background.r, Color.background.g, Color.background.b,
                         appearancePreview.opacityValue)
          border.width: 1
          border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.28)
          clip: true

          RowLayout {
            // BlipWindow's edge inset, then the sidebar's own gutters — the
            // same geometry the real split view builds.
            anchors.fill: parent
            anchors.margins: root.liveSpace(12)
            spacing: 0

            Item {
              Layout.preferredWidth: appearancePreview.configuredSidebar
              Layout.fillHeight: true

              ColumnLayout {
                anchors.fill: parent
                anchors.leftMargin: root.liveSpace(6)
                anchors.rightMargin: root.liveSpace(18)
                anchors.topMargin: root.liveSpace(10)
                anchors.bottomMargin: root.liveSpace(10)
                spacing: root.liveSpace(8)

                RowLayout {
                  Layout.fillWidth: true
                  spacing: root.liveSpace(8)
                  Text {
                    text: "Blip"
                    textFormat: Text.PlainText
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.title
                    font.bold: true
                  }
                  Text {
                    Layout.fillWidth: true
                    text: "ALL CAUGHT UP"
                    textFormat: Text.PlainText
                    color: Qt.darker(root.foreground, 1.4)
                    font.family: root.fontFamily
                    font.pixelSize: root.liveFontSize(Style.font.caption)
                    font.bold: true
                    font.letterSpacing: 1.2
                    elide: Text.ElideRight
                  }
                  Text {
                    text: "⚙"
                    textFormat: Text.PlainText
                    color: root.accent
                    font.family: root.fontFamily
                    font.pixelSize: root.liveFontSize(Style.font.icon)
                  }
                }

                Rectangle {
                  Layout.fillWidth: true
                  implicitHeight: 1
                  color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.20)
                }

                Rectangle {
                  Layout.fillWidth: true
                  Layout.topMargin: root.liveSpace(6)
                  implicitHeight: root.liveSpace(34)
                  radius: root.liveCorner(root.liveSpace(6))
                  color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.05)
                  border.width: 1
                  border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.24)
                  Text {
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.left: parent.left
                    anchors.leftMargin: root.liveSpace(9)
                    text: "🔍 search all messages"
                    textFormat: Text.PlainText
                    color: Qt.darker(root.foreground, 1.4)
                    font.family: root.fontFamily
                    font.pixelSize: root.liveFontSize(Style.font.bodySmall)
                  }
                }

                GridLayout {
                  id: previewPinGrid
                  Layout.fillWidth: true
                  Layout.topMargin: root.liveSpace(6)
                  columns: appearancePreview.configuredSidebar < 400 ? 3 : 4
                  columnSpacing: root.liveSpace(6)
                  rowSpacing: root.liveSpace(8)

                  Repeater {
                    model: [
                      { initials: "AR", label: "Alex", chosen: true },
                      { initials: "D", label: "Design", chosen: false },
                      { initials: "M", label: "Morgan", chosen: false },
                      { initials: "S", label: "Sam", chosen: false }
                    ].slice(0, previewPinGrid.columns)
                    delegate: PreviewAvatar {
                      required property var modelData
                      Layout.fillWidth: true
                      diameter: appearancePreview.pinAvatarSize
                      initials: modelData.initials
                      label: modelData.label
                      selected: modelData.chosen
                    }
                  }
                }

                PreviewThreadRow {
                  Layout.fillWidth: true
                  diameter: appearancePreview.rowAvatarSize
                  initials: "JD"
                  name: "Jordan Diaz"
                  detail: "See you at seven"
                  time: root.preferences && !root.preferences.use12HourConversationTimes ? "19:04" : "7:04 PM"
                }
                PreviewThreadRow {
                  Layout.fillWidth: true
                  diameter: appearancePreview.rowAvatarSize
                  initials: "T"
                  name: "Trail crew"
                  detail: "You: Sounds good"
                  time: "Yesterday"
                }
                Item { Layout.fillHeight: true }
              }
            }

            Rectangle {
              Layout.preferredWidth: 1
              Layout.fillHeight: true
              color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.20)
            }

            Item {
              Layout.fillWidth: true
              Layout.fillHeight: true

              ColumnLayout {
                anchors.fill: parent
                anchors.margins: root.liveSpace(12)
                spacing: root.liveSpace(10)
                Text {
                  Layout.fillWidth: true
                  text: "Jordan Diaz"
                  textFormat: Text.PlainText
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.title
                  font.bold: true
                }
                Rectangle {
                  Layout.fillWidth: true
                  implicitHeight: 1
                  color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.20)
                }
                Item { Layout.fillHeight: true }
                RowLayout {
                  Layout.fillWidth: true
                  PreviewBubble {
                    mine: false
                    label: "Their bubble"
                    fillColor: root.incomingFill
                    textColor: root.incomingText
                  }
                  Item { Layout.fillWidth: true }
                }
                RowLayout {
                  Layout.fillWidth: true
                  Item { Layout.fillWidth: true }
                  PreviewBubble {
                    mine: true
                    label: "Your bubble"
                    fillColor: root.outgoingFill
                    textColor: root.outgoingText
                  }
                }
                Text {
                  Layout.alignment: Qt.AlignHCenter
                  text: root.preferences && !root.preferences.use12HourConversationTimes ? "19:04" : "7:04 PM"
                  textFormat: Text.PlainText
                  color: Qt.darker(root.foreground, 1.45)
                  font.family: root.fontFamily
                  font.pixelSize: root.liveFontSize(Style.font.caption)
                }
                Rectangle {
                  Layout.fillWidth: true
                  implicitHeight: root.liveSpace(34)
                  radius: root.liveCorner(root.liveSpace(6))
                  color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.04)
                  border.width: 1
                  border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.24)
                  Text {
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.left: parent.left
                    anchors.leftMargin: root.liveSpace(9)
                    text: "iMessage"
                    textFormat: Text.PlainText
                    color: Qt.darker(root.foreground, 1.5)
                    font.family: root.fontFamily
                    font.pixelSize: root.liveFontSize(Style.font.caption)
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  // Mirrors BlipView's PinnedConversation geometry: avatar + name centered
  // in the tile, selection shown as the rounded background the app uses.
  component PreviewAvatar: Item {
    id: previewAvatarItem
    property real diameter: root.liveSpace(30)
    property string initials: "A"
    property string label: "Alex"
    property bool selected: false
    implicitHeight: previewAvatarContent.implicitHeight + root.liveSpace(12)

    Rectangle {
      anchors.fill: parent
      radius: root.liveCorner(root.liveSpace(12))
      color: previewAvatarItem.selected
        ? Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.08)
        : "transparent"
    }

    Column {
      id: previewAvatarContent
      anchors.centerIn: parent
      width: parent.width - root.liveSpace(8)
      spacing: root.liveSpace(4)

      Item {
        width: parent.width
        height: previewAvatarItem.diameter

        Rectangle {
          anchors.horizontalCenter: parent.horizontalCenter
          width: previewAvatarItem.diameter
          height: width
          radius: width / 2
          color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.18)
          Text {
            anchors.centerIn: parent
            text: previewAvatarItem.initials
            textFormat: Text.PlainText
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: root.liveFontSize(Style.font.bodySmall)
            font.bold: true
          }
        }
      }
      Text {
        width: parent.width
        horizontalAlignment: Text.AlignHCenter
        text: previewAvatarItem.label
        textFormat: Text.PlainText
        elide: Text.ElideRight
        maximumLineCount: 1
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: root.liveFontSize(Style.font.caption)
      }
    }
  }

  component PreviewThreadRow: RowLayout {
    id: previewThread
    property real diameter: root.liveSpace(24)
    property string initials: "A"
    property string name: "Alex"
    property string detail: "Message preview"
    property string time: "7:04 PM"
    spacing: root.liveSpace(8)

    // the unread-dot gutter the real rows reserve
    Rectangle {
      width: root.liveSpace(9); height: width; radius: width / 2
      color: root.outgoingFill
      opacity: 0
    }

    Rectangle {
      implicitWidth: previewThread.diameter
      implicitHeight: previewThread.diameter
      radius: width / 2
      color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.18)
      Text {
        anchors.centerIn: parent
        text: previewThread.initials
        textFormat: Text.PlainText
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: root.liveFontSize(Style.font.caption)
      }
    }
    ColumnLayout {
      Layout.fillWidth: true
      spacing: root.liveSpace(1)
      RowLayout {
        Layout.fillWidth: true
        spacing: root.liveSpace(6)
        Text {
          Layout.fillWidth: true
          text: previewThread.name
          textFormat: Text.PlainText
          elide: Text.ElideRight
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: root.liveFontSize(Style.font.bodySmall)
        }
        Text {
          text: previewThread.time
          textFormat: Text.PlainText
          color: Qt.darker(root.foreground, 1.45)
          font.family: root.fontFamily
          font.pixelSize: root.liveFontSize(Style.font.caption)
        }
      }
      Text {
        Layout.fillWidth: true
        text: previewThread.detail
        textFormat: Text.PlainText
        elide: Text.ElideRight
        color: Qt.darker(root.foreground, 1.4)
        font.family: root.fontFamily
        font.pixelSize: root.liveFontSize(Style.font.caption)
      }
    }
  }

  component PreviewBubble: Item {
    id: previewBubble
    property bool mine: false
    property string label: ""
    property color fillColor: root.incomingFill
    property color textColor: root.incomingText

    Layout.preferredWidth: Math.ceil(previewLabel.implicitWidth) + root.liveSpace(22)
    Layout.preferredHeight: Math.ceil(previewLabel.implicitHeight) + root.liveSpace(14)

    Shape {
      anchors.fill: parent
      antialiasing: true
      ShapePath {
        id: previewPath
        readonly property real r: Math.min(
          root.liveCorner(root.liveSpace(16)), previewBubble.width / 2, previewBubble.height / 2
        )
        strokeColor: "transparent"
        fillColor: previewBubble.fillColor
        startX: r
        startY: 0
        PathLine { x: previewBubble.width - previewPath.r; y: 0 }
        PathQuad {
          x: previewBubble.width; y: previewPath.r
          controlX: previewBubble.width; controlY: 0
        }
        PathLine {
          x: previewBubble.width
          y: previewBubble.mine ? previewBubble.height : previewBubble.height - previewPath.r
        }
        PathQuad {
          x: previewBubble.mine ? previewBubble.width : previewBubble.width - previewPath.r
          y: previewBubble.height
          controlX: previewBubble.width; controlY: previewBubble.height
        }
        PathLine { x: previewBubble.mine ? previewPath.r : 0; y: previewBubble.height }
        PathQuad {
          x: 0
          y: previewBubble.mine ? previewBubble.height - previewPath.r : previewBubble.height
          controlX: 0; controlY: previewBubble.height
        }
        PathLine { x: 0; y: previewPath.r }
        PathQuad {
          x: previewPath.r; y: 0
          controlX: 0; controlY: 0
        }
      }
    }

    Text {
      id: previewLabel
      anchors.centerIn: parent
      text: previewBubble.label
      textFormat: Text.PlainText
      color: previewBubble.textColor
      font.family: root.fontFamily
      font.pixelSize: root.liveFontSize(Style.font.bodySmall)
    }
  }

  component ColorSetting: ColumnLayout {
    id: colorSetting
    property string title: ""
    property string preferenceKey: ""
    property string currentValue: "theme"
    property color resolvedColor: root.accent
    readonly property bool editorActive: field.activeFocus
    spacing: root.space(5)

    function syncField() {
      if (!field.activeFocus) field.text = currentValue === "theme" ? "" : currentValue
    }
    function focusField() { field.forceActiveFocus() }
    function commit() {
      var candidate = field.text.trim().toLowerCase()
      if (candidate === "" || candidate === "theme") candidate = "theme"
      if (candidate !== "theme" && !/^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(candidate)) {
        root.localError = title + ": use #rrggbb, #rrggbbaa, or Theme"
        return
      }
      root.localError = ""
      if (root.preferences) root.preferences.setColor(preferenceKey, candidate)
      syncField()
    }
    onCurrentValueChanged: syncField()
    Component.onCompleted: syncField()

    Text {
      text: colorSetting.title
      textFormat: Text.PlainText
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: root.fontSize(Style.font.bodySmall)
      font.bold: true
    }
    RowLayout {
      Layout.fillWidth: true
      spacing: root.space(8)
      Rectangle {
        width: root.space(28); height: width
        radius: root.corner(root.space(8))
        color: colorSetting.resolvedColor
        border.width: 1
        border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.45)
      }
      TextField {
        id: field
        Layout.fillWidth: true
        placeholderText: "theme"
        foreground: root.foreground
        accent: root.accent
        font.family: root.fontFamily
        font.pixelSize: root.fontSize(Style.font.bodySmall)
        maximumLength: 9
        onAccepted: colorSetting.commit()
        onEditingFinished: colorSetting.commit()
      }
      ActionButton {
        label: "Theme"
        onClicked: {
          field.text = ""
          root.localError = ""
          if (root.preferences) root.preferences.setColor(colorSetting.preferenceKey, "theme")
        }
      }
    }
  }

  component PreferenceSlider: ColumnLayout {
    id: sliderRow
    property string title: ""
    property string preferenceKey: ""
    property real currentValue: 0
    property real from: 0
    property real to: 1
    property real stepSize: 0.1
    property int decimals: 0
    property real multiplier: 1
    property string suffix: ""
    spacing: root.space(4)

    onCurrentValueChanged: if (!slider.pressed) slider.value = currentValue

    RowLayout {
      Layout.fillWidth: true
      Text {
        Layout.fillWidth: true
        text: sliderRow.title
        textFormat: Text.PlainText
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: root.fontSize(Style.font.bodySmall)
      }
      Text {
        text: (slider.value * sliderRow.multiplier).toFixed(sliderRow.decimals) + sliderRow.suffix
        textFormat: Text.PlainText
        color: root.accent
        font.family: root.fontFamily
        font.pixelSize: root.fontSize(Style.font.caption)
        font.bold: true
      }
    }
    QQC.Slider {
      id: slider
      Layout.fillWidth: true
      from: sliderRow.from
      to: sliderRow.to
      stepSize: sliderRow.stepSize
      value: sliderRow.currentValue
      onMoved: {
        root.resetArmed = false
        root.localError = ""
        if (root.preferences) root.preferences.setNumber(sliderRow.preferenceKey, value)
      }
      background: Rectangle {
        x: slider.leftPadding
        y: slider.topPadding + slider.availableHeight / 2 - height / 2
        implicitWidth: 200
        implicitHeight: root.space(4)
        width: slider.availableWidth
        height: implicitHeight
        radius: height / 2
        color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.18)
        Rectangle {
          width: slider.visualPosition * parent.width
          height: parent.height
          radius: parent.radius
          color: root.accent
        }
      }
      handle: Rectangle {
        x: slider.leftPadding + slider.visualPosition * (slider.availableWidth - width)
        y: slider.topPadding + slider.availableHeight / 2 - height / 2
        implicitWidth: root.space(16)
        implicitHeight: width
        radius: width / 2
        color: root.accent
        border.width: slider.activeFocus ? 2 : 1
        border.color: root.foreground
      }
    }
  }

  component ActionButton: Rectangle {
    id: action
    property string label: ""
    property bool danger: false
    property bool selected: false
    signal clicked()
    implicitWidth: actionText.implicitWidth + root.space(18)
    implicitHeight: actionText.implicitHeight + root.space(12)
    radius: root.corner(root.space(8))
    color: actionHover.hovered
      ? Qt.rgba((danger ? root.urgent : root.accent).r,
                (danger ? root.urgent : root.accent).g,
                (danger ? root.urgent : root.accent).b, 0.18)
      : selected ? Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.18)
      : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.06)
    border.width: 1
    border.color: danger ? root.urgent : selected ? root.accent
      : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.35)
    Text {
      id: actionText
      anchors.centerIn: parent
      text: action.label
      textFormat: Text.PlainText
      color: action.danger ? root.urgent : root.foreground
      font.family: root.fontFamily
      font.pixelSize: root.fontSize(Style.font.caption)
      font.bold: action.danger || action.selected
    }
    HoverHandler { id: actionHover; cursorShape: Qt.PointingHandCursor }
    TapHandler { onTapped: action.clicked() }
  }
}
