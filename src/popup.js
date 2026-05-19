import { saveHandle, getHandle } from './idb-helper.js';

let currentHandle = null;
let sourceMode = 'local'; // 'local' or 'github'

// DOM Elements
const selectWorkspaceBtn = document.getElementById('selectWorkspaceBtn');
const syncBtn = document.getElementById('syncBtn');
const refreshBtn = document.getElementById('refreshBtn');
const statusDiv = document.getElementById('status');
const workspaceInfo = document.getElementById('workspaceInfo');
const fileListDiv = document.getElementById('fileList');
const autoSaveToggle = document.getElementById('autoSaveToggle');
const treeActionsDiv = document.getElementById('treeActions');
const expandAllBtn = document.getElementById('expandAllBtn');
const collapseAllBtn = document.getElementById('collapseAllBtn');

const tabLocal = document.getElementById('tabLocal');
const tabGitHub = document.getElementById('tabGitHub');
const localPanel = document.getElementById('localPanel');
const githubPanel = document.getElementById('githubPanel');

const gitRepoInput = document.getElementById('gitRepo');
const gitBranchInput = document.getElementById('gitBranch');
const gitTokenInput = document.getElementById('gitToken');
const gitFetchBtn = document.getElementById('gitFetchBtn');
const gitDetectBtn = document.getElementById('gitDetectBtn');

// Theme management
const themeToggle = document.getElementById('themeToggle');
const themeIcon = document.querySelector('.theme-icon');

chrome.storage.local.get({ theme: 'light' }, (res) => {
  setTheme(res.theme);
});

if (themeToggle) {
  themeToggle.addEventListener('click', () => {
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    chrome.storage.local.set({ theme: newTheme });
  });
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  if (themeIcon) {
    themeIcon.textContent = theme === 'light' ? '🌙' : '☀️';
  }
}

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
  return appId ? appId : 'default';
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
      if (treeActionsDiv) {
        treeActionsDiv.style.display = 'none';
      }
      fileListDiv.innerHTML = '<div style="padding: 10px; text-align: center; color: #6c757d;">Open an AI Studio page to get started.</div>';
      showStatus('Waiting for active AI Studio tab...');
      return;
    }

    const appIdKey = await getStorageKey();
    
    // Retrieve stored source mode for this project
    const storedModeRes = await new Promise(resolve => {
      chrome.storage.local.get([`sourceMode_${appIdKey}`], res => {
        resolve(res[`sourceMode_${appIdKey}`] || 'local');
      });
    });
    
    sourceMode = storedModeRes;
    
    // Toggle active tab buttons and panels
    if (sourceMode === 'local') {
      tabLocal.classList.add('active');
      tabGitHub.classList.remove('active');
      localPanel.classList.add('active');
      githubPanel.classList.remove('active');
      
      currentHandle = await getHandle(`workspaceHandle_${appIdKey}`);
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
          if (treeActionsDiv) {
            treeActionsDiv.style.display = 'none';
          }
          showStatus('Permission required to read files.', true);
        }
      } else {
        workspaceInfo.textContent = 'No Workspace Selected';
        syncBtn.style.display = 'none';
        refreshBtn.style.display = 'none';
        if (treeActionsDiv) {
          treeActionsDiv.style.display = 'none';
        }
        fileListDiv.innerHTML = '<div style="padding: 10px; text-align: center; color: #6c757d;">Please select a local workspace for this project.</div>';
        showStatus('Ready.');
      }
    } else {
      tabLocal.classList.remove('active');
      tabGitHub.classList.add('active');
      localPanel.classList.remove('active');
      githubPanel.classList.add('active');
      
      workspaceInfo.textContent = 'GitHub Sync Mode';
      syncBtn.style.display = 'none';
      refreshBtn.style.display = 'none';
      
      const githubConfig = await new Promise(resolve => {
        chrome.storage.local.get([`githubConfig_${appIdKey}`], res => {
          resolve(res[`githubConfig_${appIdKey}`] || null);
        });
      });
      
      if (githubConfig) {
        gitRepoInput.value = githubConfig.repo || '';
        gitBranchInput.value = githubConfig.branch || 'main';
        gitTokenInput.value = githubConfig.token || '';
        if (githubConfig.repo) {
          fetchGitHubTree();
        }
      } else {
        gitRepoInput.value = '';
        gitBranchInput.value = 'main';
        gitTokenInput.value = '';
        autoDetectGit();
      }
    }
  } catch (error) {
    console.error('Failed to load handle:', error);
    showStatus('Failed to load saved workspace.', true);
  }
}

async function setSourceMode(mode) {
  sourceMode = mode;
  const appIdKey = await getStorageKey();
  chrome.storage.local.set({ [`sourceMode_${appIdKey}`]: mode });
  initWorkspace();
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
    if (treeActionsDiv) {
      treeActionsDiv.style.display = 'none';
    }
    return;
  }

  if (treeActionsDiv) {
    treeActionsDiv.style.display = 'flex';
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
      
      const ext = nodeName.split('.').pop().toLowerCase();
      let fileIcon = '📄';
      if (['js', 'jsx'].includes(ext)) fileIcon = '🟨';
      else if (['ts', 'tsx'].includes(ext)) fileIcon = '🟦';
      else if (ext === 'json') fileIcon = '🔸';
      else if (['html', 'htm'].includes(ext)) fileIcon = '🌐';
      else if (ext === 'css') fileIcon = '🎨';
      else if (ext === 'md') fileIcon = '📝';
      else if (['png', 'jpg', 'jpeg', 'gif', 'svg'].includes(ext)) fileIcon = '🖼️';
      else if (['yml', 'yaml'].includes(ext)) fileIcon = '⚙️';
      
      const nameSpan = document.createElement('span');
      nameSpan.className = 'tree-file-name';
      nameSpan.textContent = `${fileIcon} ${nodeName}`;
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
      
      const folderIconSpan = document.createElement('span');
      folderIconSpan.textContent = '📂 ';
      
      const folderNameSpan = document.createElement('span');
      folderNameSpan.textContent = nodeName;
      
      folderItem.appendChild(arrow);
      folderItem.appendChild(folderIconSpan);
      folderItem.appendChild(folderNameSpan);
      
      const childrenContainer = document.createElement('div');
      childrenContainer.className = 'tree-folder-children';
      
      folderItem.addEventListener('click', (e) => {
        e.stopPropagation();
        const collapsed = childrenContainer.style.display === 'none';
        childrenContainer.style.display = collapsed ? 'block' : 'none';
        arrow.textContent = collapsed ? '▼' : '▶';
        arrow.style.transform = collapsed ? 'none' : 'rotate(-90deg)';
        folderIconSpan.textContent = collapsed ? '📂 ' : '📁 ';
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

function getMimeType(fileName) {
  const ext = fileName.split('.').pop().toLowerCase();
  switch (ext) {
    case 'js': return 'text/javascript';
    case 'ts': return 'text/typescript';
    case 'tsx': return 'text/typescript';
    case 'json': return 'application/json';
    case 'html': return 'text/html';
    case 'css': return 'text/css';
    case 'md': return 'text/markdown';
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    default: return 'text/plain';
  }
}

async function syncSingleFile(fileHandle, relativePath) {
  showStatus(`Syncing: ${relativePath}...`);
  try {
    let base64 = '';
    let fileName = relativePath.split('/').pop();
    let fileType = getMimeType(fileName);

    if (fileHandle.git) {
      // Fetch raw content from GitHub using Blobs API
      const headers = {
        'Accept': 'application/vnd.github.raw'
      };
      const tokenVal = gitTokenInput.value.trim();
      if (tokenVal) {
        headers['Authorization'] = `token ${tokenVal}`;
      }
      
      const res = await fetch(fileHandle.url, { headers });
      if (!res.ok) {
        throw new Error(`Failed to fetch file from GitHub (HTTP ${res.status})`);
      }
      
      const arrayBuffer = await res.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      base64 = btoa(binary);
    } else {
      // Local Workspace Mode
      const file = await fileHandle.getFile();
      fileName = file.name;
      fileType = file.type;
      
      base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = (e) => reject(e);
        reader.readAsDataURL(file);
      });
    }

    const tab = await getActiveTab();
    if (!tab) {
      throw new Error('No active tab found.');
    }

    const autoSave = autoSaveToggle ? autoSaveToggle.checked : true;

    try {
      await chrome.tabs.sendMessage(tab.id, {
        action: 'syncFile',
        fileName: fileName,
        filePath: relativePath,
        fileType: fileType,
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

async function fetchGitHubTree() {
  const repoVal = gitRepoInput.value.trim();
  const branchVal = gitBranchInput.value.trim();
  const tokenVal = gitTokenInput.value.trim();

  if (!repoVal) {
    showStatus('Repository owner/repo is required.', true);
    return;
  }
  if (!branchVal) {
    showStatus('Branch is required.', true);
    return;
  }

  showStatus('Fetching repository tree from GitHub...');
  fileListDiv.innerHTML = '<div style="padding: 10px; text-align: center; color: #6c757d;">Loading files from GitHub...</div>';
  
  try {
    const headers = {};
    if (tokenVal) {
      headers['Authorization'] = `token ${tokenVal}`;
    }
    
    // Save settings
    const appIdKey = await getStorageKey();
    chrome.storage.local.set({
      [`githubConfig_${appIdKey}`]: { repo: repoVal, branch: branchVal, token: tokenVal }
    });

    const res = await fetch(`https://api.github.com/repos/${repoVal}/git/trees/${branchVal}?recursive=1`, { headers });
    if (!res.ok) {
      if (res.status === 404) {
        throw new Error('Repository or Branch not found. Make sure it is correct and public, or provide a Personal Access Token.');
      }
      throw new Error(`GitHub API returned HTTP ${res.status}`);
    }

    const data = await res.json();
    if (!data.tree || !Array.isArray(data.tree)) {
      throw new Error('Invalid response from GitHub API tree endpoint.');
    }

    const files = [];
    data.tree.forEach(item => {
      if (item.type === 'blob') {
        const parts = item.path.split('/');
        const hasIgnoredSegment = parts.some(part => 
          part.startsWith('.') || 
          part === 'node_modules' || 
          part === 'dist' || 
          part === 'build' ||
          part === 'package-lock.json'
        );
        if (!hasIgnoredSegment) {
          files.push({
            handle: {
              git: true,
              sha: item.sha,
              url: item.url,
              path: item.path
            },
            path: item.path
          });
        }
      }
    });

    buildAndRenderTree(files, fileListDiv);
    showStatus(`Fetched ${files.length} files from GitHub. Choose a file to sync.`);
  } catch (err) {
    console.error(err);
    showStatus(`GitHub Fetch Error: ${err.message}`, true);
    fileListDiv.innerHTML = `<div style="padding: 10px; text-align: center; color: #dc3545;">Failed to load files: ${err.message}</div>`;
    if (treeActionsDiv) {
      treeActionsDiv.style.display = 'none';
    }
  }
}

async function autoDetectGit() {
  const tab = await getActiveTab();
  if (!tab) return;
  
  showStatus('Attempting to auto-detect GitHub repo...');
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { action: 'detectGit' });
    if (res && res.gitInfo) {
      gitRepoInput.value = res.gitInfo.repo || '';
      gitBranchInput.value = res.gitInfo.branch || 'main';
      showStatus(`Auto-detected: ${res.gitInfo.repo} on ${res.gitInfo.branch}`);
      
      // Auto fetch after successful detection
      fetchGitHubTree();
    } else {
      showStatus('Could not auto-detect Git settings. Please enter them manually.');
    }
  } catch (err) {
    console.warn('Failed to contact content script for Git auto-detection:', err);
    showStatus('Please make sure you have the Git panel open in AI Studio to auto-detect.', true);
  }
}

function expandAll() {
  const folders = document.querySelectorAll('.tree-folder');
  folders.forEach(folder => {
    const arrow = folder.querySelector('.tree-folder-arrow');
    const childrenContainer = folder.nextElementSibling;
    if (childrenContainer && childrenContainer.classList.contains('tree-folder-children')) {
      childrenContainer.style.display = 'block';
      if (arrow) {
        arrow.textContent = '▼';
        arrow.style.transform = 'none';
      }
    }
  });
}

function collapseAll() {
  const folders = document.querySelectorAll('.tree-folder');
  folders.forEach(folder => {
    const arrow = folder.querySelector('.tree-folder-arrow');
    const childrenContainer = folder.nextElementSibling;
    if (childrenContainer && childrenContainer.classList.contains('tree-folder-children')) {
      childrenContainer.style.display = 'none';
      if (arrow) {
        arrow.textContent = '▶';
        arrow.style.transform = 'rotate(-90deg)';
      }
    }
  });
}

// Event Listeners
selectWorkspaceBtn.addEventListener('click', async () => {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'read' });
    currentHandle = handle;
    const key = await getStorageKey();
    await saveHandle(`workspaceHandle_${key}`, handle);
    
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

if (expandAllBtn) {
  expandAllBtn.addEventListener('click', expandAll);
}
if (collapseAllBtn) {
  collapseAllBtn.addEventListener('click', collapseAll);
}

tabLocal.addEventListener('click', () => setSourceMode('local'));
tabGitHub.addEventListener('click', () => setSourceMode('github'));
gitFetchBtn.addEventListener('click', fetchGitHubTree);
gitDetectBtn.addEventListener('click', autoDetectGit);

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
