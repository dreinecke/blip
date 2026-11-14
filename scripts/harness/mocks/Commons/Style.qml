pragma Singleton
import QtQuick
// C-009 mock: the members BlipView's closure uses, with the real theme's
// numbers (space is identity at scale 1.0; font sizes from Style.qml's
// tokens; popupPadding 14; alpha fills at the real alphas).
QtObject {
  function space(px) {
    var n = Number(px)
    if (!isFinite(n) || n <= 0) return 0
    return Math.max(1, Math.round(n))
  }
  property int cornerRadius: 0
  property real hoverFillAlpha: 0.08
  property real selectionFillAlpha: 0.16
  function hoverFillFor(foreground, accent, urgent) {
    return Qt.rgba(foreground.r, foreground.g, foreground.b, hoverFillAlpha)
  }
  function selectionFillFor(foreground, accent, urgent) {
    return Qt.rgba(foreground.r, foreground.g, foreground.b, selectionFillAlpha)
  }
  function controlFill(focused, hot, foreground, accent) {
    return Qt.rgba(foreground.r, foreground.g, foreground.b, focused ? 0.14 : hot ? 0.08 : 0.05)
  }
  readonly property QtObject spacing: QtObject {
    readonly property int popupPadding: 14
    readonly property int inputPaddingY: 7
    readonly property int controlPaddingX: 10
    readonly property int controlGap: 8
    readonly property int sm: 4
    readonly property int hairline: 1
  }
  readonly property QtObject font: QtObject {
    readonly property string family: "monospace"
    readonly property int caption: 10
    readonly property int bodySmall: 11
    readonly property int body: 12
    readonly property int subtitle: 13
    readonly property int icon: 14
    readonly property int title: 14
    readonly property int display: 24
  }
}
