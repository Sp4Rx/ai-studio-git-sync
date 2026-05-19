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

async function loadSavedHandle() {
  try {
    currentHandle = await getHandle('workspaceHandle');
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
        showStatus('Permission required to read files.', true);
      }
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

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      throw new Error('No active tab found.');
    }

    try {
      await chrome.tabs.sendMessage(tab.id, {
        action: 'syncFile',
        fileName: file.name,
        filePath: relativePath, // Send the relative path!
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
    await saveHandle('workspaceHandle', handle);
    
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

// Initialize
document.addEventListener('DOMContentLoaded', loadSavedHandle);
