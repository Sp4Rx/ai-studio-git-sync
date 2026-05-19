// Background Service Worker

chrome.runtime.onInstalled.addListener(() => {
  console.log('AI Studio Git Sync installed.');
  // Disable the action button globally by default on install/update
  chrome.action.disable();
});

// Configure the side panel to open when the toolbar action icon is clicked
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('Error setting panel behavior:', error));

// Show/enable side panel and action icon ONLY on Google AI Studio tabs
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab.url) return;

  const isAIStudio = tab.url.includes('aistudio.google.com');
  if (isAIStudio) {
    chrome.action.enable(tabId, () => {
      if (chrome.runtime.lastError) {} // Suppress errors if tab is closed
    });
    chrome.sidePanel.setOptions({
      tabId: tabId,
      path: 'index.html',
      enabled: true
    }, () => {
      if (chrome.runtime.lastError) {}
    });
  } else {
    chrome.action.disable(tabId, () => {
      if (chrome.runtime.lastError) {}
    });
    chrome.sidePanel.setOptions({
      tabId: tabId,
      enabled: false
    }, () => {
      if (chrome.runtime.lastError) {}
    });
  }
});

// Log messages from content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'log') {
    console.log('[Content Script]:', request.message);
  }
});
