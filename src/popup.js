import { saveHandle, getHandle } from './idb-helper.js';

let currentHandle = null;

const selectWorkspaceBtn = document.getElementById('selectWorkspaceBtn');
const syncBtn = document.getElementById('syncBtn');
const refreshBtn = document.getElementById('refreshBtn');
const statusDiv = document.getElementById('status');
const workspaceInfo = document.getElementById('workspaceInfo');
const fileListDiv = document.getElementById('fileList');
const autoSaveToggle = document.getElementById('autoSaveToggle');

// Load stored autosave preference
chrome.storage.local.get({ autoSaveEnabled: true }, (res) => {
  if (autoSaveToggle) {
    autoSaveToggle.checked = res.autoSaveEnabled;
  }
});

// Save autosave preference when changed
if (autoSaveToggle) {
  autoSaveToggle.addEventListener('change', () => {
    chrome.storage.local.set({ autoSaveEnabled: autoSaveToggle.checked });
  });
}

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
    buildAndRenderTree(files, fileListDiv);
    showStatus('Workspace loaded. Choose a file to sync.');
  } catch (err) {
    console.error(err);
    showStatus(`Failed to read files: ${err.message}`, true);
  }
}

function buildAndRenderTree(files, container) {
  container.innerHTML = '';
  
  if (files.length === 0) {
    container.innerHTML = '<div style="padding: 10px; text-align: center; color: #6c757d;">No files found</div>';
    return;
  }

  // 1. Build nested tree structure
  const tree = {};
  files.forEach(file => {
    const parts = file.path.split('/');
    let current = tree;
    parts.forEach((part, index) => {
      const isFile = index === parts.length - 1;
      if (!current[part]) {
        current[part] = isFile ? { _file: file } : { _dir: {} };
      }
      current = isFile ? current[part] : current[part]._dir;
    });
  });

  // 2. Recursive renderer
  function render(nodeName, node, parentEl, depth) {
    if (node._file) {
      // File Node
      const fileInfo = node._file;
      const fileItem = document.createElement('div');
      fileItem.className = 'tree-file';
      
      const nameSpan = document.createElement('span');
      nameSpan.className = 'tree-file-name';
      nameSpan.textContent = `📄 ${nodeName}`;
      nameSpan.title = fileInfo.path;
      
      const btn = document.createElement('button');
      btn.className = 'sync-btn-small';
      btn.textContent = 'Sync';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        syncSingleFile(fileInfo.handle, fileInfo.path);
      });
      
      fileItem.appendChild(nameSpan);
      fileItem.appendChild(btn);
      parentEl.appendChild(fileItem);
    } else {
      // Directory Node
      const folderItem = document.createElement('div');
      folderItem.className = 'tree-folder';
      
      const arrow = document.createElement('span');
      arrow.className = 'tree-folder-arrow';
      arrow.textContent = '▼';
      arrow.style.marginRight = '6px';
      arrow.style.fontSize = '9px';
      arrow.style.display = 'inline-block';
      arrow.style.width = '10px';
      
      const folderName = document.createElement('span');
      folderName.textContent = `📁 ${nodeName}`;
      
      folderItem.appendChild(arrow);
      folderItem.appendChild(folderName);
      
      const childrenContainer = document.createElement('div');
      childrenContainer.className = 'tree-folder-children';
      
      folderItem.addEventListener('click', (e) => {
        e.stopPropagation();
        const collapsed = childrenContainer.style.display === 'none';
        childrenContainer.style.display = collapsed ? 'block' : 'none';
        arrow.textContent = collapsed ? '▼' : '▶';
        arrow.style.transform = collapsed ? 'none' : 'rotate(-90deg)';
      });
      
      parentEl.appendChild(folderItem);
      parentEl.appendChild(childrenContainer);
      
      // Sort keys: folders first, then files alphabetically
      const keys = Object.keys(node._dir || {});
      keys.sort((a, b) => {
        const aIsDir = !node._dir[a]._file;
        const bIsDir = !node._dir[b]._file;
        if (aIsDir && !bIsDir) return -1;
        if (!aIsDir && bIsDir) return 1;
        return a.localeCompare(b);
      });
      
      keys.forEach(key => {
        render(key, node._dir[key], childrenContainer, depth + 1);
      });
    }
  }

  // Render root level keys
  const rootKeys = Object.keys(tree);
  rootKeys.sort((a, b) => {
    const aIsDir = !tree[a]._file;
    const bIsDir = !tree[b]._file;
    if (aIsDir && !bIsDir) return -1;
    if (!aIsDir && bIsDir) return 1;
    return a.localeCompare(b);
  });
  
  rootKeys.forEach(key => {
    render(key, tree[key], container, 0);
  });
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

    const autoSave = autoSaveToggle ? autoSaveToggle.checked : true;

    try {
      await chrome.tabs.sendMessage(tab.id, {
        action: 'syncFile',
        fileName: file.name,
        filePath: relativePath,
        fileType: file.type,
        fileData: base64,
        autoSave: autoSave
      });
      if (autoSave) {
        showStatus(`Synced and autosaved: ${relativePath}`);
      } else {
        showStatus(`Synced: ${relativePath} (Press Save in Web IDE to save)`);
      }
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
