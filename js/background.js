/**
 * Chrome 拡張として読み込んだときのエントリ。
 * ポップアップだと作業領域が狭いので、ツールバーアイコンからタブで開く。
 */
/* global chrome */
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("index.html") })
})
