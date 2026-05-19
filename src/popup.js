import { saveHandle, getHandle } from './idb-helper.js';

let currentHandle = null;

const selectWorkspaceBtn = document.getElementById('selectWorkspaceBtn');
const syncBtn = document.getElementById('syncBtn');
const statusDiv = document.getElementById('status');
const workspaceInfo = document.getElementById('workspaceInfo');

function showStatus(message, isError = false) {
  statusDiv.textContent = message;
  if (isError) {
    statusDiv.classList.add('error');
  } else {
    statusDiv.classList.remove('error');
  }
}

async function loadSavedHandle() {
  try {
    currentHandle = await getHandle('workspaceHandle');
    if (currentHandle) {
      // Verify permissions. Browsers require re-verification of handle permissions on new sessions.
      const permission = await currentHandle.queryPermission({ mode: 'read' });
      if (permission === 'granted') {
        workspaceInfo.textContent = `Selected: ${currentHandle.name}`;
        syncBtn.disabled = false;
        showStatus('Workspace ready.');
      } else {
        workspaceInfo.textContent = `Needs permission: ${currentHandle.name}`;
        syncBtn.disabled = false; // We will ask for permission when they click sync
        showStatus('Click Sync to grant permission.', true);
      }
    }
  } catch (error) {
    console.error('Failed to load handle:', error);
  }
}

selectWorkspaceBtn.addEventListener('click', async () => {
  try {
    const handle = await window.showDirectoryPicker({
      mode: 'read'
    });
    
    currentHandle = handle;
    await saveHandle('workspaceHandle', handle);
    
    workspaceInfo.textContent = `Selected: ${handle.name}`;
    syncBtn.disabled = false;
    showStatus('Workspace selected successfully!');
  } catch (error) {
    // User cancelled or error
    if (error.name !== 'AbortError') {
      showStatus(`Error: ${error.message}`, true);
    }
  }
});

syncBtn.addEventListener('click', async () => {
  if (!currentHandle) {
    showStatus('Please select a workspace first.', true);
    return;
  }

  showStatus('Requesting permissions & reading files...');
  
  try {
    // Verify permission
    const permission = await currentHandle.queryPermission({ mode: 'read' });
    if (permission !== 'granted') {
      const requestPerm = await currentHandle.requestPermission({ mode: 'read' });
      if (requestPerm !== 'granted') {
        throw new Error('Permission denied to read folder');
      }
    }

    // Now we need to communicate with the background script to orchestrate the sync
    // Wait, the popup can't easily pass File handles to the background script.
    // However, the popup *can* read the files and send their contents to the content script directly!
    // Since we are reading the active tab to inject.
    
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab) {
      throw new Error('No active tab found.');
    }

    // Example logic to read files. In a real scenario, you'd iterate the folder.
    // For this boilerplate, let's assume we iterate all files and send them.
    showStatus('Sync started... check console in Web IDE tab.');
    
    // Iterate files logic
    for await (const entry of currentHandle.values()) {
      if (entry.kind === 'file') {
        const file = await entry.getFile();
        
        // Let's send a message for each file to the background script or content script directly.
        // We will send to background script to forward to content, or we can send directly to content script.
        // Since it's binary, we might need to convert it to base64 or ArrayBuffer if sending via Chrome messaging.
        
        // Convert to base64 to safely pass via messaging
        const buffer = await file.arrayBuffer();
        const base64 = btoa(
          new Uint8Array(buffer).reduce(
            (data, byte) => data + String.fromCharCode(byte),
            ''
          )
        );

        chrome.tabs.sendMessage(tab.id, {
          action: 'syncFile',
          fileName: file.name,
          fileType: file.type,
          fileData: base64
        });
      }
    }
    
    showStatus('Sync commands sent!');

  } catch (error) {
    console.error(error);
    showStatus(`Sync error: ${error.message}`, true);
  }
});

// Initialize
document.addEventListener('DOMContentLoaded', loadSavedHandle);
