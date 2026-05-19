// Background Service Worker
chrome.runtime.onInstalled.addListener(() => {
  console.log('Local to Web Studio Syncer installed.');
});

// We can handle message passing here if needed, but popup directly messaging content script is often simpler.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'log') {
    console.log('[Content Script]:', request.message);
  }
});
