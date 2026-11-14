import QtQuick
// C-009 mock: text + streamFinished is the whole surface BlipView uses.
QtObject {
  property string text: ""
  property bool splitChunks: false
  signal streamFinished()
}
