import { saveHandle, getHandle } from './idb-helper.js';

let currentHandle = null;

const selectWorkspaceBtn = document.getElementById('selectWorkspaceBtn');
const syncBtn = document.getElementById('syncBtn');
const refreshBtn = document.getElementById('refreshBtn');
const statusDiv = document.getElementById('status');
const workspaceInfo = document.getElementById('workspaceInfo');
const fileListDiv = document.getElementById('fileList');

function showStatus(message, isError = false) {
  statusDiv.textContent = message;
  if (isError) {
    statusDiv.classList.add('error');
  } else {
    statusDiv.classList.remove('error');
  }
}

async function getActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  } catch (e) {
    console.error('Error querying active tab:', e);
    return null;
  }
}

function getAppId(url) {
  if (!url) return null;
  const match = url.match(/\/apps\/([a-zA-Z0-9\-]+)/);
  return match ? match[1] : null;
}

async function getStorageKey() {
  const tab = await getActiveTab();
  const appId = tab ? getAppId(tab.url) : null;
  return appId ? `workspaceHandle_${appId}` : 'workspaceHandle_default';
}

async function verifyPermission(handle, readWrite) {
  const options = {};
  if (readWrite) {
    options.mode = 'readwrite';
  }
  if ((await handle.queryPermission(options)) === 'granted') {
    return true;
  }
  if ((await handle.requestPermission(options)) === 'granted') {
    return true;
  }
  return false;
}

async function initWorkspace() {
  try {
    const tab = await getActiveTab();
    if (!tab || !tab.url || !tab.url.includes('aistudio.google.com')) {
      workspaceInfo.textContent = 'Ready';
      syncBtn.style.display = 'none';
      refreshBtn.style.display = 'none';
      fileListDiv.innerHTML = '<div style="padding: 10px; text-align: center; color: #6c757d;">Open an AI Studio page to get started.</div>';
      showStatus('Waiting for active AI Studio tab...');
      return;
    }

    const key = await getStorageKey();
    currentHandle = await getHandle(key);
    
    if (currentHandle) {
      const permission = await currentHandle.queryPermission({ mode: 'read' });
      if (permission === 'granted') {
        workspaceInfo.textContent = `Selected: ${currentHandle.name}`;
        syncBtn.style.display = 'none';
        refreshBtn.style.display = 'block';
        showStatus('Reading files...');
        await listFiles(currentHandle);
      } else {
        workspaceInfo.textContent = `Needs permission: ${currentHandle.name}`;
        syncBtn.style.display = 'block';
        refreshBtn.style.display = 'none';
        fileListDiv.innerHTML = '';
        showStatus('Permission required to read files.', true);
      }
    } else {
      workspaceInfo.textContent = 'No Workspace Selected';
      syncBtn.style.display = 'none';
      refreshBtn.style.display = 'none';
      fileListDiv.innerHTML = '<div style="padding: 10px; text-align: center; color: #6c757d;">Please select a local workspace for this project.</div>';
      showStatus('Ready.');
    }
  } catch (error) {
    console.error('Failed to load handle:', error);
    showStatus('Failed to load saved workspace.', true);
  }
}

async function listFiles(dirHandle) {
  fileListDiv.innerHTML = '';
  try {
    const files = [];
    
    async function scan(handle, path = '') {
      for await (const entry of handle.values()) {
        // Skip dotfiles, node_modules, dist, build, package-lock.json
        if (entry.name.startsWith('.') || 
            entry.name === 'node_modules' || 
            entry.name === 'dist' || 
            entry.name === 'build' ||
            entry.name === 'package-lock.json') {
          continue;
        }
        const entryPath = path ? `${path}/${entry.name}` : entry.name;
        if (entry.kind === 'file') {
          files.push({ handle: entry, path: entryPath });
        } else if (entry.kind === 'directory') {
          await scan(entry, entryPath);
        }
      }
    }

    await scan(dirHandle);
    
    // Sort files alphabetically
    files.sort((a, b) => a.path.localeCompare(b.path));

    if (files.length === 0) {
      fileListDiv.innerHTML = '<div style="padding: 10px; text-align: center; color: #6c757d;">No files found</div>';
      showStatus('Workspace loaded.');
      return;
    }

    files.forEach(fileInfo => {
      const item = document.createElement('div');
      item.className = 'file-item';
      
      const span = document.createElement('span');
      span.textContent = fileInfo.path;
      span.title = fileInfo.path;
      
      const btn = document.createElement('button');
      btn.className = 'sync-btn-small';
      btn.textContent = 'Sync';
      btn.addEventListener('click', () => syncSingleFile(fileInfo.handle, fileInfo.path));
      
      item.appendChild(span);
      item.appendChild(btn);
      fileListDiv.appendChild(item);
    });
    
    showStatus('Workspace loaded. Choose a file to sync.');
  } catch (err) {
    console.error(err);
    showStatus(`Failed to read files: ${err.message}`, true);
  }
}

async function syncSingleFile(fileHandle, relativePath) {
  showStatus(`Syncing: ${relativePath}...`);
  try {
    const file = await fileHandle.getFile();
    
    // Use FileReader for non-blocking Async base64 conversion
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = (e) => reject(e);
      reader.readAsDataURL(file);
    });

    const tab = await getActiveTab();
    if (!tab) {
      throw new Error('No active tab found.');
    }

    try {
      await chrome.tabs.sendMessage(tab.id, {
        action: 'syncFile',
        fileName: file.name,
        filePath: relativePath,
        fileType: file.type,
        fileData: base64
      });
      showStatus(`Synced: ${relativePath}`);
    } catch (err) {
      throw new Error('Content script not found. Please refresh the Web IDE tab and try again.');
    }
  } catch (error) {
    console.error(error);
    showStatus(`Sync error: ${error.message}`, true);
  }
}

selectWorkspaceBtn.addEventListener('click', async () => {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'read' });
    currentHandle = handle;
    const key = await getStorageKey();
    await saveHandle(key, handle);
    
    workspaceInfo.textContent = `Selected: ${handle.name}`;
    syncBtn.style.display = 'none';
    refreshBtn.style.display = 'block';
    showStatus('Reading files...');
    await listFiles(handle);
  } catch (error) {
    if (error.name !== 'AbortError') {
      showStatus(`Error: ${error.message}`, true);
    }
  }
});

syncBtn.addEventListener('click', async () => {
  if (!currentHandle) return;
  const granted = await verifyPermission(currentHandle, false);
  if (granted) {
    workspaceInfo.textContent = `Selected: ${currentHandle.name}`;
    syncBtn.style.display = 'none';
    refreshBtn.style.display = 'block';
    showStatus('Reading files...');
    await listFiles(currentHandle);
  } else {
    showStatus('Permission denied.', true);
  }
});

refreshBtn.addEventListener('click', async () => {
  if (!currentHandle) return;
  showStatus('Refreshing file list...');
  await listFiles(currentHandle);
});

// Tab listeners to automatically update popup state when the active project or page changes
chrome.tabs.onActivated.addListener(() => {
  initWorkspace();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'complete') {
    initWorkspace();
  }
});

// Initialize on load
document.addEventListener('DOMContentLoaded', initWorkspace);
