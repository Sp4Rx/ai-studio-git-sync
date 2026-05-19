// Background Service Worker
chrome.runtime.onInstalled.addListener(() => {
  console.log('Local to Web Studio Syncer installed.');
});

// Configure the extension to open the side panel when the toolbar icon is clicked
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('Error setting panel behavior:', error));

// We can handle message passing here if needed
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'log') {
    console.log('[Content Script]:', request.message);
  }
});
