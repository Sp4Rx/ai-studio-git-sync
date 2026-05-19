import { saveHandle, getHandle } from './idb-helper.js';

let currentHandle = null;
let sourceMode = 'local'; // 'local' or 'github'
let modifiedGitFiles = []; // files modified in AI Studio Git tab
let lastLoadedAppId = null;
let lastLoadedSourceMode = null;
let fileStates = {}; // key: relativePath, value: 'added' | 'modified' | 'identical'
let currentWorkspaceFiles = []; // currently loaded workspace/repo files
let deletedFiles = []; // files that exist in AI Studio but are deleted in source (local/GitHub)
let lastPromptedFilesStr = '';
let pendingGitAlertFiles = [];

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
const fullDiffBtn = document.getElementById('fullDiffBtn');
const loaderOverlay = document.getElementById('loaderOverlay');
const loaderMessage = document.getElementById('loaderMessage');

const gitTabAlertModal = document.getElementById('gitTabAlertModal');
const gitAlertCount = document.getElementById('gitAlertCount');
const gitAlertConfirmBtn = document.getElementById('gitAlertConfirmBtn');
const gitAlertCancelBtn = document.getElementById('gitAlertCancelBtn');

const tabLocal = document.getElementById('tabLocal');
const tabGitHub = document.getElementById('tabGitHub');
const localPanel = document.getElementById('localPanel');
const githubPanel = document.getElementById('githubPanel');

const gitRepoInput = document.getElementById('gitRepo');
const gitBranchInput = document.getElementById('gitBranch');
const gitTokenInput = document.getElementById('gitToken');
const gitFetchBtn = document.getElementById('gitFetchBtn');
const gitDetectBtn = document.getElementById('gitDetectBtn');

// Diff Modal DOM Elements & State
const diffModal = document.getElementById('diffModal');
const diffFilePath = document.getElementById('diffFilePath');
const diffView = document.getElementById('diffView');
const closeDiffBtn = document.getElementById('closeDiffBtn');
const confirmSyncBtn = document.getElementById('confirmSyncBtn');
const cancelSyncBtn = document.getElementById('cancelSyncBtn');
let currentDiffTarget = null;
let monacoModels = [];

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
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    // If not aistudio or active tab doesn't match, find an open AI studio tab
    if (!tab || !tab.url || !tab.url.includes('aistudio.google.com')) {
      const allTabs = await chrome.tabs.query({ url: "*://aistudio.google.com/*" });
      if (allTabs.length > 0) {
        tab = allTabs[0];
      }
    }
    
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

    const appId = getAppId(tab.url);
    if (!appId) {
      workspaceInfo.textContent = 'No App Open';
      syncBtn.style.display = 'none';
      refreshBtn.style.display = 'none';
      if (treeActionsDiv) {
        treeActionsDiv.style.display = 'none';
      }
      fileListDiv.innerHTML = '<div style="padding: 10px; text-align: center; color: #6c757d;">Please open a project/app inside Google AI Studio to start syncing.</div>';
      showStatus('Waiting for open AI Studio app...');
      return;
    }

    const appIdKey = await getStorageKey();
    
    // Retrieve stored source mode for this project
    const storedModeRes = await new Promise(resolve => {
      chrome.storage.local.get([`sourceMode_${appIdKey}`], res => {
        resolve(res[`sourceMode_${appIdKey}`] || 'local');
      });
    });
    
    if (appIdKey === lastLoadedAppId && storedModeRes === lastLoadedSourceMode) {
      return;
    }
    
    lastLoadedAppId = appIdKey;
    lastLoadedSourceMode = storedModeRes;
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
  lastLoadedSourceMode = null; // Force reload
  const appIdKey = await getStorageKey();
  chrome.storage.local.set({ [`sourceMode_${appIdKey}`]: mode });
  initWorkspace();
}

async function listFiles(dirHandle) {
  fileListDiv.innerHTML = '';
  try {
    deletedFiles = [];
    fileStates = {};
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
    currentWorkspaceFiles = files;
    buildAndRenderTree(files, fileListDiv);
    showStatus('Workspace loaded. Choose a file to sync.');
    detectAndRenderModifiedFiles(files);
  } catch (err) {
    console.error(err);
    showStatus(`Failed to read files: ${err.message}`, true);
  }
}

async function detectAndRenderModifiedFiles(files) {
  currentWorkspaceFiles = files;
  try {
    const paths = files.map(f => f.path);
    const tab = await getActiveTab();
    if (!tab) return;
    
    showStatus('Scanning AI Studio files...');

    // 1. Fetch Monaco models
    const monacoResponse = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { action: 'getMonacoModels' }, (res) => {
        if (chrome.runtime.lastError) {
          resolve(null);
        } else {
          resolve(res || null);
        }
      });
    });

    if (monacoResponse && monacoResponse.success && monacoResponse.models) {
      monacoModels = monacoResponse.models;
      console.log('Monaco models loaded:', monacoModels);
    } else {
      monacoModels = [];
    }
    
    // 2. Fetch modified files
    const response = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { action: 'getGitModifiedFiles', filePaths: paths }, (res) => {
        if (chrome.runtime.lastError) {
          resolve(null);
        } else {
          resolve(res || null);
        }
      });
    });

    let prefix = 'Workspace loaded';
    const currentStatus = statusDiv.textContent || '';
    if (currentStatus.includes('Fetch complete')) {
      prefix = 'Fetch complete';
    } else if (currentStatus.includes('Workspace loaded')) {
      prefix = 'Workspace loaded';
    }

    if (response && response.modifiedFiles) {
      modifiedGitFiles = response.modifiedFiles;
      console.log('Modified files detected in AI Studio:', modifiedGitFiles);
      buildAndRenderTree(files, fileListDiv);
      showStatus(`${prefix} (${modifiedGitFiles.length} modified files found in Git)`);
    } else {
      buildAndRenderTree(files, fileListDiv);
      showStatus(`${prefix} (No modified files found in Git)`);
    }
  } catch (e) {
    console.error('Failed to detect files:', e);
    buildAndRenderTree(files, fileListDiv);
    showStatus('Workspace loaded. Choose a file to sync.');
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

  const hasRunDiff = Object.keys(fileStates).length > 0;
  const diffCheckHint = document.getElementById('diffCheckHint');
  if (diffCheckHint) {
    diffCheckHint.style.display = hasRunDiff ? 'none' : 'flex';
  }

  // 1. Render Git Changes flat list at the top if there are any modified or deleted files
  const hasModified = modifiedGitFiles && modifiedGitFiles.length > 0;
  const hasDeleted = deletedFiles && deletedFiles.length > 0;

  if (hasModified || hasDeleted) {
    const gitChangesHeader = document.createElement('div');
    gitChangesHeader.className = 'git-changes-header';
    gitChangesHeader.style.display = 'flex';
    gitChangesHeader.style.alignItems = 'center';
    gitChangesHeader.style.justifyContent = 'space-between';
    gitChangesHeader.style.padding = '8px 12px';
    gitChangesHeader.style.margin = '4px';
    gitChangesHeader.style.background = 'var(--autosave-bg)';
    gitChangesHeader.style.color = 'var(--autosave-text)';
    gitChangesHeader.style.borderRadius = '10px';
    gitChangesHeader.style.border = '1px solid var(--autosave-border)';
    gitChangesHeader.style.fontSize = '12px';
    gitChangesHeader.style.fontWeight = '600';
    
    const totalChanges = modifiedGitFiles.length + deletedFiles.length;
    const titleSpan = document.createElement('span');
    titleSpan.textContent = `⚡ Git Changes (${totalChanges})`;
    gitChangesHeader.appendChild(titleSpan);
    
    const dynamicSyncAllBtn = document.createElement('button');
    dynamicSyncAllBtn.className = 'sync-btn-small';
    dynamicSyncAllBtn.textContent = 'Sync All';
    dynamicSyncAllBtn.style.padding = '2px 8px';
    dynamicSyncAllBtn.style.fontSize = '10px';
    dynamicSyncAllBtn.style.backgroundColor = 'var(--btn-bg)';
    dynamicSyncAllBtn.style.color = 'var(--btn-text)';
    dynamicSyncAllBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await runSyncAll(files);
    });
    gitChangesHeader.appendChild(dynamicSyncAllBtn);
    container.appendChild(gitChangesHeader);
    
    const gitChangesList = document.createElement('div');
    gitChangesList.className = 'git-changes-list';
    gitChangesList.style.margin = '4px 4px 12px 4px';
    gitChangesList.style.border = '1px solid var(--border-color)';
    gitChangesList.style.borderRadius = '10px';
    gitChangesList.style.padding = '4px';
    gitChangesList.style.background = 'var(--card-bg)';
    
    // Render modified/added files
    modifiedGitFiles.forEach(path => {
      const fileInfo = files.find(f => f.path === path);
      if (!fileInfo) return;
      
      const fileItem = document.createElement('div');
      fileItem.className = 'tree-file';
      fileItem.style.padding = '5px 8px';
      
      const ext = path.split('.').pop().toLowerCase();
      let fileIcon = '📄';
      if (['js', 'jsx'].includes(ext)) fileIcon = '🟨';
      else if (['ts', 'tsx'].includes(ext)) fileIcon = '🟦';
      else if (ext === 'json') fileIcon = '🔸';
      else if (['html', 'htm'].includes(ext)) fileIcon = '🌐';
      else if (ext === 'css') fileIcon = '🎨';
      else if (ext === 'md') fileIcon = '📝';
      
      const nameSpan = document.createElement('span');
      nameSpan.className = 'tree-file-name';
      nameSpan.style.maxWidth = '60%';
      
      const dot = document.createElement('span');
      dot.style.color = '#e28743';
      dot.style.marginRight = '4px';
      dot.textContent = '●';
      nameSpan.appendChild(dot);
      
      const textNode = document.createTextNode(` ${fileIcon} ${path}`);
      nameSpan.appendChild(textNode);
      nameSpan.title = path;
      
      fileItem.appendChild(nameSpan);
      
      const actionsWrapper = document.createElement('div');
      actionsWrapper.className = 'tree-actions-wrapper';
      actionsWrapper.style.display = 'flex';
      actionsWrapper.style.gap = '4px';
      actionsWrapper.style.alignItems = 'center';
      
      const binaryExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'zip', 'tar', 'gz', 'exe', 'dll', 'mp4', 'mp3', 'wav', 'woff', 'woff2', 'ttf', 'eot', 'ico', 'bin'];
      const isTextFile = !binaryExtensions.includes(ext);
      if (isTextFile) {
        const diffBtn = document.createElement('button');
        diffBtn.className = 'sync-btn-small btn-secondary';
        diffBtn.textContent = 'Diff';
        diffBtn.style.padding = '3px 8px';
        diffBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          showDiff(fileInfo.handle, fileInfo.path);
        });
        actionsWrapper.appendChild(diffBtn);
      }
      
      // Check if file is new to Monaco
      const relPath = path.toLowerCase().replace(/\\/g, '/');
      const existsInMonaco = monacoModels.some(m => {
        const uriStr = m.uri.toLowerCase().replace(/\\/g, '/');
        return uriStr.endsWith('/' + relPath) || 
               uriStr.endsWith('model/' + relPath) || 
               uriStr === relPath ||
               uriStr.includes('/' + relPath + '?') || 
               (relPath.includes('/') === false && uriStr.endsWith('/' + relPath));
      });
      const state = fileStates[path];
      const isNew = state ? (state === 'added') : !existsInMonaco;

      const syncBtnSmall = document.createElement('button');
      syncBtnSmall.className = 'sync-btn-small';
      syncBtnSmall.textContent = isNew ? 'Upload' : 'Sync';
      syncBtnSmall.style.backgroundColor = 'var(--btn-green-bg)';
      syncBtnSmall.style.color = 'var(--btn-green-text)';
      syncBtnSmall.addEventListener('click', (e) => {
        e.stopPropagation();
        syncSingleFile(fileInfo.handle, fileInfo.path);
      });
      actionsWrapper.appendChild(syncBtnSmall);
      
      fileItem.appendChild(actionsWrapper);
      gitChangesList.appendChild(fileItem);
    });

    // Render deleted files
    deletedFiles.forEach(path => {
      const fileItem = document.createElement('div');
      fileItem.className = 'tree-file';
      fileItem.style.padding = '5px 8px';
      
      const ext = path.split('.').pop().toLowerCase();
      let fileIcon = '📄';
      if (['js', 'jsx'].includes(ext)) fileIcon = '🟨';
      else if (['ts', 'tsx'].includes(ext)) fileIcon = '🟦';
      else if (ext === 'json') fileIcon = '🔸';
      else if (['html', 'htm'].includes(ext)) fileIcon = '🌐';
      else if (ext === 'css') fileIcon = '🎨';
      else if (ext === 'md') fileIcon = '📝';
      
      const nameSpan = document.createElement('span');
      nameSpan.className = 'tree-file-name';
      nameSpan.style.maxWidth = '60%';
      
      const dot = document.createElement('span');
      dot.style.color = '#dc3545';
      dot.style.marginRight = '4px';
      dot.textContent = '●';
      nameSpan.appendChild(dot);
      
      const textNode = document.createTextNode(` ${fileIcon} [Deleted] ${path}`);
      nameSpan.appendChild(textNode);
      nameSpan.title = `${path} (Deleted in local/GitHub)`;
      
      fileItem.appendChild(nameSpan);
      
      const actionsWrapper = document.createElement('div');
      actionsWrapper.className = 'tree-actions-wrapper';
      actionsWrapper.style.display = 'flex';
      actionsWrapper.style.gap = '4px';
      actionsWrapper.style.alignItems = 'center';
      
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'sync-btn-small';
      deleteBtn.textContent = 'Delete';
      deleteBtn.style.backgroundColor = '#dc3545';
      deleteBtn.style.color = '#ffffff';
      deleteBtn.style.border = 'none';
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteSingleFile(path);
      });
      actionsWrapper.appendChild(deleteBtn);
      
      fileItem.appendChild(actionsWrapper);
      gitChangesList.appendChild(fileItem);
    });
    
    container.appendChild(gitChangesList);
    
    const divider = document.createElement('div');
    divider.style.borderTop = '1px solid var(--border-color)';
    divider.style.margin = '12px 4px';
    container.appendChild(divider);
  }

  // 2. Build nested tree structure
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

  // 3. Recursive renderer
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
      
      const isModified = modifiedGitFiles.includes(fileInfo.path);

      // Check if file exists in Monaco models
      const relPath = fileInfo.path.toLowerCase().replace(/\\/g, '/');
      const existsInMonaco = monacoModels.some(m => {
        const uriStr = m.uri.toLowerCase().replace(/\\/g, '/');
        return uriStr.endsWith('/' + relPath) || 
               uriStr.endsWith('model/' + relPath) || 
               uriStr === relPath ||
               uriStr.includes('/' + relPath + '?') || 
               (relPath.includes('/') === false && uriStr.endsWith('/' + relPath));
      });

      if (isModified) {
        const dot = document.createElement('span');
        dot.style.color = '#e28743'; // nice warm orange
        dot.style.marginRight = '4px';
        dot.textContent = '●';
        dot.title = 'Modified in AI Studio';
        nameSpan.prepend(dot);
      }
      
      const actionsWrapper = document.createElement('div');
      actionsWrapper.className = 'tree-actions-wrapper';
      actionsWrapper.style.display = 'flex';
      actionsWrapper.style.gap = '4px';
      actionsWrapper.style.alignItems = 'center';

      const binaryExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'zip', 'tar', 'gz', 'exe', 'dll', 'mp4', 'mp3', 'wav', 'woff', 'woff2', 'ttf', 'eot', 'ico', 'bin'];
      const isTextFile = !binaryExtensions.includes(ext);

      if (isTextFile) {
        const diffBtn = document.createElement('button');
        diffBtn.className = 'sync-btn-small btn-secondary';
        diffBtn.textContent = 'Diff';
        diffBtn.style.padding = '3px 8px';
        diffBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          showDiff(fileInfo.handle, fileInfo.path);
        });
        actionsWrapper.appendChild(diffBtn);
      }

      const syncBtnSmall = document.createElement('button');
      syncBtnSmall.className = 'sync-btn-small';
      
      // Determine label and style based on state:
      // 1. Modified -> Sync (Green/Blue primary style)
      // 2. Not in Monaco (New File) -> Upload (Green/Blue primary style)
      // 3. In Monaco but Unmodified -> Overwrite (Gray secondary style)
      const state = fileStates[fileInfo.path];
      const hasRunDiff = (state !== undefined);
      let needSync = false;
      let isNew = false;
      if (hasRunDiff) {
        needSync = (state === 'modified' || state === 'added');
        isNew = (state === 'added');
      } else {
        needSync = isModified || !existsInMonaco;
        isNew = !existsInMonaco;
      }
      
      if (!hasRunDiff) {
        syncBtnSmall.className = 'sync-btn-small state-standard';
        syncBtnSmall.textContent = 'Sync';
      } else if (needSync) {
        syncBtnSmall.className = 'sync-btn-small state-modified';
        syncBtnSmall.textContent = isNew ? 'Upload' : 'Sync';
      } else {
        syncBtnSmall.className = 'sync-btn-small state-identical';
        syncBtnSmall.textContent = 'Overwrite';
      }



      syncBtnSmall.addEventListener('click', (e) => {
        e.stopPropagation();
        syncSingleFile(fileInfo.handle, fileInfo.path);
      });
      actionsWrapper.appendChild(syncBtnSmall);
      
      fileItem.appendChild(nameSpan);
      fileItem.appendChild(actionsWrapper);
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



async function deleteSingleFile(path, bypassConfirm = false) {
  if (!bypassConfirm) {
    const confirmDelete = confirm(`Are you sure you want to delete "${path}" from Google AI Studio?`);
    if (!confirmDelete) return;
  }

  showStatus(`Deleting ${path} from AI Studio...`);
  try {
    const tab = await getActiveTab();
    if (!tab) {
      throw new Error('No active AI Studio tab found.');
    }

    const response = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { action: 'deleteFile', filePath: path }, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(res || { success: false, error: 'No response' });
        }
      });
    });

    if (response && response.success) {
      deletedFiles = deletedFiles.filter(p => p !== path);
      showStatus(`Deleted ${path} successfully.`);
      buildAndRenderTree(currentWorkspaceFiles, fileListDiv);
    } else {
      throw new Error(response ? response.error : 'Failed to delete file');
    }
  } catch (err) {
    console.error(err);
    showStatus(`Delete failed: ${err.message}`, true);
  }
}

let isSyncCancelled = false;

async function runSyncAll(files) {
  const modifiedCount = modifiedGitFiles.length;
  const deletedCount = deletedFiles.length;
  const total = modifiedCount + deletedCount;
  
  if (total === 0) {
    showStatus('No changes to sync.');
    return;
  }
  
  let message = `Are you sure you want to sync all ${total} changes to Google AI Studio?`;
  if (deletedCount > 0) {
    message = `This will sync/upload ${modifiedCount} files and delete ${deletedCount} files from AI Studio. Are you sure you want to proceed?`;
  }
  const proceed = confirm(message);
  if (!proceed) return;
  
  isSyncCancelled = false;
  
  loaderOverlay.style.display = 'flex';
  const originalLoaderHTML = loaderOverlay.innerHTML;
  
  const filesHTML = [
    ...modifiedGitFiles.map(path => `
      <div class="progress-file-item" data-path="${path}" style="display: flex; justify-content: space-between; align-items: center; font-size: 11px; margin: 4px 0; color: var(--text-color);">
        <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 70%; display: flex; align-items: center; gap: 4px;">
          <span class="status-dot" style="display:inline-block; width:6px; height:6px; border-radius:50%; background:#cbd5e1;"></span>
          ${path.split('/').pop()}
        </span>
        <span class="status-text" style="color: var(--text-secondary); font-weight: 500;">Pending</span>
      </div>
    `),
    ...deletedFiles.map(path => `
      <div class="progress-file-item" data-path="${path}" style="display: flex; justify-content: space-between; align-items: center; font-size: 11px; margin: 4px 0; color: var(--danger-color);">
        <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 70%; display: flex; align-items: center; gap: 4px;">
          <span class="status-dot" style="display:inline-block; width:6px; height:6px; border-radius:50%; background:#cbd5e1;"></span>
          [Delete] ${path.split('/').pop()}
        </span>
        <span class="status-text" style="color: var(--text-secondary); font-weight: 500;">Pending</span>
      </div>
    `)
  ].join('');
  
  loaderOverlay.innerHTML = `
    <div class="loader-content" style="max-width: 300px; width: 90%; max-height: 80vh; display: flex; flex-direction: column; text-align: center; box-sizing: border-box; padding: 20px;">
      <div class="spinner" style="margin-bottom: 10px;"></div>
      <div id="loaderMessage" style="font-weight: 700; margin-bottom: 12px; font-size: 13px;">Syncing 0 of ${total} files...</div>
      
      <div id="progressFilesContainer" style="flex: 1; overflow-y: auto; max-height: 180px; border: 1px solid var(--border-color); border-radius: 8px; padding: 6px; margin-bottom: 14px; background: var(--bg-color); text-align: left;">
        ${filesHTML}
      </div>
      
      <button id="cancelSyncAllBtn" class="btn" style="margin: 0; background: var(--danger-color); color: white; border: none; font-weight: 600; font-size: 12px; padding: 8px 12px;">Cancel Sync</button>
    </div>
  `;
  
  const cancelBtn = loaderOverlay.querySelector('#cancelSyncAllBtn');
  cancelBtn.addEventListener('click', () => {
    isSyncCancelled = true;
    cancelBtn.textContent = 'Cancelling...';
    cancelBtn.disabled = true;
  });
  
  function setProgressStatus(path, statusStr, color, dotColor) {
    const items = loaderOverlay.querySelectorAll('.progress-file-item');
    for (const item of items) {
      if (item.getAttribute('data-path') === path) {
        const textEl = item.querySelector('.status-text');
        const dotEl = item.querySelector('.status-dot');
        if (textEl) {
          textEl.textContent = statusStr;
          textEl.style.color = color;
        }
        if (dotEl) {
          dotEl.style.backgroundColor = dotColor;
        }
        item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        break;
      }
    }
  }
  
  let processed = 0;
  const tab = await getActiveTab();
  
  if (tab) {
    // 1. Process modified / added files
    for (const path of modifiedGitFiles) {
      if (isSyncCancelled) break;
      processed++;
      
      const loaderMsg = loaderOverlay.querySelector('#loaderMessage');
      if (loaderMsg) {
        loaderMsg.textContent = `Syncing ${processed} of ${total} files...\n(${path.split('/').pop()})`;
      }
      
      setProgressStatus(path, 'Syncing...', 'var(--btn-bg)', 'var(--btn-bg)');
      
      const fileInfo = files.find(f => f.path === path);
      if (fileInfo) {
        try {
          let base64 = '';
          let fileName = path.split('/').pop();
          let fileType = getMimeType(fileName);
          
          if (fileInfo.handle.git) {
            const headers = { 'Accept': 'application/vnd.github.raw' };
            const tokenVal = gitTokenInput.value.trim();
            if (tokenVal) headers['Authorization'] = `token ${tokenVal}`;
            const res = await fetch(fileInfo.handle.url, { headers });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const arrayBuffer = await res.arrayBuffer();
            const bytes = new Uint8Array(arrayBuffer);
            let binary = '';
            for (let i = 0; i < bytes.byteLength; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            base64 = btoa(binary);
          } else {
            const file = await fileInfo.handle.getFile();
            fileName = file.name;
            fileType = file.type;
            base64 = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result.split(',')[1]);
              reader.onerror = (e) => reject(e);
              reader.readAsDataURL(file);
            });
          }
          
          const autoSave = autoSaveToggle ? autoSaveToggle.checked : true;
          
          await new Promise((resolve) => {
            chrome.tabs.sendMessage(tab.id, {
              action: 'syncFile',
              fileName,
              filePath: path,
              fileType,
              fileData: base64,
              autoSave,
              closeAfterSync: true,
              skipWorkspaceSave: true
            }, () => {
              resolve();
            });
          });
          
          setProgressStatus(path, 'Done', 'var(--success-color)', 'var(--success-color)');
        } catch (err) {
          console.error(`Failed to sync ${path}:`, err);
          setProgressStatus(path, 'Failed', 'var(--danger-color)', 'var(--danger-color)');
        }
      }
    }
    
    // 2. Process deleted files
    for (const path of [...deletedFiles]) {
      if (isSyncCancelled) break;
      processed++;
      
      const loaderMsg = loaderOverlay.querySelector('#loaderMessage');
      if (loaderMsg) {
        loaderMsg.textContent = `Deleting ${processed} of ${total} files...\n(${path.split('/').pop()})`;
      }
      
      setProgressStatus(path, 'Deleting...', 'var(--danger-color)', 'var(--danger-color)');
      
      try {
        await deleteSingleFile(path, true);
        setProgressStatus(path, 'Deleted', 'var(--success-color)', 'var(--success-color)');
      } catch (err) {
        console.error(`Failed to delete ${path}:`, err);
        setProgressStatus(path, 'Failed', 'var(--danger-color)', 'var(--danger-color)');
      }
    }
  }
  
  loaderOverlay.innerHTML = originalLoaderHTML;
  loaderOverlay.style.display = 'none';
  
  if (isSyncCancelled) {
    showStatus('Sync was cancelled by user.', true);
  } else {
    const autoSave = autoSaveToggle ? autoSaveToggle.checked : true;
    if (autoSave && tab) {
      await new Promise((resolve) => {
        chrome.tabs.sendMessage(tab.id, { action: 'triggerWorkspaceSave' }, () => {
          resolve();
        });
      });
    }
    showStatus('Sync all completed successfully.');
  }
  
  fileStates = {};
  modifiedGitFiles = [];
  deletedFiles = [];
  buildAndRenderTree(currentWorkspaceFiles, fileListDiv);
}

// Decodes a base64 string to a UTF-8 string
function decodeBase64ToUTF8(base64) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

// Compute line-by-line diff using standard LCS backtrack
function diffLines(oldText, newText) {
  const oldLines = oldText.split(/\r?\n/);
  const newLines = newText.split(/\r?\n/);
  
  const M = oldLines.length;
  const N = newLines.length;
  const dp = Array.from({ length: M + 1 }, () => Array(N + 1).fill(0));
  
  for (let i = 1; i <= M; i++) {
    for (let j = 1; j <= N; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  
  let i = M, j = N;
  const result = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.unshift({ type: 'unchanged', text: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ type: 'added', text: newLines[j - 1] });
      j--;
    } else {
      result.unshift({ type: 'removed', text: oldLines[i - 1] });
      i--;
    }
  }
  return result;
}

// Fetches the active Monaco models from AI Studio
async function refreshMonacoModels() {
  try {
    const tab = await getActiveTab();
    if (!tab) return;
    const response = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { action: 'getMonacoModels' }, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(res || { success: false, error: 'No response' });
        }
      });
    });
    if (response && response.success) {
      monacoModels = response.models || [];
    } else {
      monacoModels = [];
    }
  } catch (e) {
    console.error('Error refreshing Monaco models:', e);
    monacoModels = [];
  }
}

// Renders the diff and shows the modal
async function showDiff(fileHandle, relativePath) {
  showStatus(`Comparing ${relativePath}...`);
  try {
    // 1. Read source file content (local or GitHub)
    let sourceContent = '';
    if (fileHandle.git) {
      const headers = { 'Accept': 'application/vnd.github.raw' };
      const tokenVal = gitTokenInput.value.trim();
      if (tokenVal) headers['Authorization'] = `token ${tokenVal}`;
      const res = await fetch(fileHandle.url, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      sourceContent = await res.text();
    } else {
      const file = await fileHandle.getFile();
      sourceContent = await file.text();
    }

    const tab = await getActiveTab();
    if (!tab) {
      throw new Error('No active AI Studio tab found.');
    }

    // 2. Fetch the Monaco content from browser tab (with background loading fallback)
    const response = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { action: 'getFileContent', filePath: relativePath }, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(res || { success: false, error: 'No response' });
        }
      });
    });

    diffFilePath.textContent = relativePath;
    diffView.innerHTML = '';
    currentDiffTarget = { handle: fileHandle, path: relativePath };

    if (response && response.success) {
      const studioContent = response.content || '';
      const diffs = diffLines(studioContent, sourceContent);
      
      let hasChanges = false;
      diffs.forEach(line => {
        const lineEl = document.createElement('span');
        if (line.type === 'added') {
          lineEl.className = 'diff-line diff-line-added';
          lineEl.textContent = `+ ${line.text}`;
          hasChanges = true;
        } else if (line.type === 'removed') {
          lineEl.className = 'diff-line diff-line-removed';
          lineEl.textContent = `- ${line.text}`;
          hasChanges = true;
        } else {
          lineEl.className = 'diff-line diff-line-unchanged';
          lineEl.textContent = `  ${line.text}`;
        }
        diffView.appendChild(lineEl);
      });

      if (!hasChanges) {
        diffView.innerHTML = '<div class="diff-line-empty">🎉 No changes! Source file is identical to AI Studio.</div>';
        fileStates[relativePath] = 'identical';
        modifiedGitFiles = modifiedGitFiles.filter(p => p !== relativePath);
      } else {
        fileStates[relativePath] = 'modified';
        if (!modifiedGitFiles.includes(relativePath)) {
          modifiedGitFiles.push(relativePath);
        }
      }
      buildAndRenderTree(currentWorkspaceFiles, fileListDiv);
    } else {
      // File not found or failed to load
      const errorMsg = response ? (response.error || 'Unknown error') : 'No response from page';
      if (errorMsg.includes('not found') || errorMsg.includes('File not found')) {
        fileStates[relativePath] = 'added';
        if (!modifiedGitFiles.includes(relativePath)) {
          modifiedGitFiles.push(relativePath);
        }
        buildAndRenderTree(currentWorkspaceFiles, fileListDiv);

        const diffs = diffLines('', sourceContent);
        diffs.forEach(line => {
          const lineEl = document.createElement('span');
          if (line.type === 'added') {
            lineEl.className = 'diff-line diff-line-added';
            lineEl.textContent = `+ ${line.text}`;
          } else if (line.type === 'removed') {
            lineEl.className = 'diff-line diff-line-removed';
            lineEl.textContent = `- ${line.text}`;
          } else {
            lineEl.className = 'diff-line diff-line-unchanged';
            lineEl.textContent = `  ${line.text}`;
          }
          diffView.appendChild(lineEl);
        });
      } else {
        diffView.innerHTML = `
          <div class="diff-line-empty" style="color: var(--text-color); font-weight: 500;">
            ⚠️ ${errorMsg}<br><br>
            <span style="font-size: 11px; font-weight: normal; color: var(--text-secondary);">
              To sync anyway, click 'Overwrite AI Studio' below.
            </span>
          </div>
        `;
      }
    }

    diffModal.style.display = 'flex';
    showStatus('Diff loaded.');
  } catch (err) {
    console.error(err);
    showStatus(`Failed to load diff: ${err.message}`, true);
  }
}

// Close the diff modal
function closeDiffModal() {
  diffModal.style.display = 'none';
  currentDiffTarget = null;
}

// Confirm and sync from the modal
async function confirmSyncFromModal() {
  if (!currentDiffTarget) return;
  const { handle, path } = currentDiffTarget;
  closeDiffModal();
  await syncSingleFile(handle, path);
}

async function runFullDiffScan() {
  if (!currentWorkspaceFiles || currentWorkspaceFiles.length === 0) {
    showStatus('No files loaded to run diff check.', true);
    return;
  }
  
  const tab = await getActiveTab();
  if (!tab) {
    showStatus('No active AI Studio tab found.', true);
    return;
  }

  // Filter out binary files
  const binaryExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'zip', 'tar', 'gz', 'exe', 'dll', 'mp4', 'mp3', 'wav', 'woff', 'woff2', 'ttf', 'eot', 'ico', 'bin'];
  const textFiles = currentWorkspaceFiles.filter(f => {
    const ext = f.path.split('.').pop().toLowerCase();
    return !binaryExtensions.includes(ext);
  });

  if (textFiles.length === 0) {
    showStatus('No text files found to diff.', true);
    return;
  }

  // 1. Show loader overlay
  loaderMessage.textContent = `Comparing 1 of ${textFiles.length} files...`;
  loaderOverlay.style.display = 'flex';

  try {
    const filePaths = textFiles.map(f => f.path);
    
    // 2. Fetch all file contents from Monaco context (content.js compareAllFiles)
    const response = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { action: 'compareAllFiles', filePaths }, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(res || { success: false, error: 'No response' });
        }
      });
    });

    if (!response || !response.success || !response.results) {
      throw new Error(response ? response.error : 'Failed to scan files in page');
    }

    const results = response.results;
    let modifiedDetected = [];
    
    // 3. For each text file, read source content and compare
    for (let i = 0; i < textFiles.length; i++) {
      const fileInfo = textFiles[i];
      const path = fileInfo.path;
      loaderMessage.textContent = `Comparing ${i + 1} of ${textFiles.length} files...\n(${fileInfo.path.split('/').pop()})`;
      
      const scanResult = results[path];
      if (!scanResult || scanResult.status === 'not_found' || scanResult.status === 'error') {
        fileStates[path] = 'added';
        modifiedDetected.push(path);
        continue;
      }
      
      const studioContent = scanResult.content || '';
      
      let sourceContent = '';
      if (fileInfo.handle.git) {
        const headers = { 'Accept': 'application/vnd.github.raw' };
        const tokenVal = gitTokenInput.value.trim();
        if (tokenVal) headers['Authorization'] = `token ${tokenVal}`;
        const res = await fetch(fileInfo.handle.url, { headers });
        if (res.ok) sourceContent = await res.text();
      } else {
        const file = await fileInfo.handle.getFile();
        sourceContent = await file.text();
      }
      
      // Compute diff to check if identical
      const diffs = diffLines(studioContent, sourceContent);
      const hasChanges = diffs.some(line => line.type === 'added' || line.type === 'removed');
      
      if (hasChanges) {
        fileStates[path] = 'modified';
        modifiedDetected.push(path);
      } else {
        fileStates[path] = 'identical';
      }
    }

    // 3.5 Detect deleted files
    if (response.studioFiles && Array.isArray(response.studioFiles)) {
      const localPaths = currentWorkspaceFiles.map(f => f.path);
      deletedFiles = response.studioFiles.filter(path => {
        const parts = path.split('/');
        const hasIgnoredSegment = parts.some(part => 
          part.startsWith('.') || 
          part === 'node_modules' || 
          part === 'dist' || 
          part === 'build' ||
          part === 'package-lock.json'
        );

        return !hasIgnoredSegment && !localPaths.includes(path);
      });
      console.log('Detected deleted files in source:', deletedFiles);
    } else {
      deletedFiles = [];
    }

    // 4. Update modifiedGitFiles list to match detected changes
    const binaryGitFiles = modifiedGitFiles.filter(path => {
      const ext = path.split('.').pop().toLowerCase();
      return binaryExtensions.includes(ext);
    });
    modifiedGitFiles = [...new Set([...modifiedDetected, ...binaryGitFiles])];

    // 5. Re-render tree
    buildAndRenderTree(currentWorkspaceFiles, fileListDiv);
    
    let prefix = 'Workspace loaded';
    const currentStatus = statusDiv.textContent || '';
    if (currentStatus.includes('Fetch complete')) {
      prefix = 'Fetch complete';
    } else if (currentStatus.includes('Workspace loaded')) {
      prefix = 'Workspace loaded';
    }
    const totalChanges = modifiedGitFiles.length + deletedFiles.length;
    showStatus(`${prefix} (${totalChanges} changes found: ${modifiedGitFiles.length} mod/add, ${deletedFiles.length} del)`);
  } catch (err) {
    console.error(err);
    showStatus(`Diff check failed: ${err.message}`, true);
  } finally {
    loaderOverlay.style.display = 'none';
  }
}

async function runDiffScanForFiles(targetPaths) {
  if (!currentWorkspaceFiles || currentWorkspaceFiles.length === 0) {
    showStatus('No files loaded to run diff check.', true);
    return;
  }
  
  const tab = await getActiveTab();
  if (!tab) {
    showStatus('No active AI Studio tab found.', true);
    return;
  }

  const binaryExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'zip', 'tar', 'gz', 'exe', 'dll', 'mp4', 'mp3', 'wav', 'woff', 'woff2', 'ttf', 'eot', 'ico', 'bin'];
  const textFiles = currentWorkspaceFiles.filter(f => {
    const ext = f.path.split('.').pop().toLowerCase();
    return !binaryExtensions.includes(ext) && targetPaths.includes(f.path);
  });

  if (textFiles.length === 0) {
    showStatus('No matching text files found to diff.', true);
    return;
  }

  loaderMessage.textContent = `Comparing 1 of ${textFiles.length} files...`;
  loaderOverlay.style.display = 'flex';

  try {
    const filePaths = textFiles.map(f => f.path);
    
    const response = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { action: 'compareAllFiles', filePaths, skipExpandAll: true }, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(res || { success: false, error: 'No response' });
        }
      });
    });

    if (!response || !response.success || !response.results) {
      throw new Error(response ? response.error : 'Failed to scan files in page');
    }

    const results = response.results;
    let modifiedDetected = [];
    
    for (let i = 0; i < textFiles.length; i++) {
      const fileInfo = textFiles[i];
      const path = fileInfo.path;
      loaderMessage.textContent = `Comparing ${i + 1} of ${textFiles.length} files...\n(${fileInfo.path.split('/').pop()})`;
      
      const scanResult = results[path];
      if (!scanResult || scanResult.status === 'not_found' || scanResult.status === 'error') {
        fileStates[path] = 'added';
        modifiedDetected.push(path);
        continue;
      }
      
      const studioContent = scanResult.content || '';
      
      let sourceContent = '';
      if (fileInfo.handle.git) {
        const headers = { 'Accept': 'application/vnd.github.raw' };
        const tokenVal = gitTokenInput.value.trim();
        if (tokenVal) headers['Authorization'] = `token ${tokenVal}`;
        const res = await fetch(fileInfo.handle.url, { headers });
        if (res.ok) sourceContent = await res.text();
      } else {
        const file = await fileInfo.handle.getFile();
        sourceContent = await file.text();
      }
      
      const diffs = diffLines(studioContent, sourceContent);
      const hasChanges = diffs.some(line => line.type === 'added' || line.type === 'removed');
      
      if (hasChanges) {
        fileStates[path] = 'modified';
        modifiedDetected.push(path);
      } else {
        fileStates[path] = 'identical';
      }
    }

    const scannedPaths = textFiles.map(f => f.path);
    modifiedGitFiles = modifiedGitFiles.filter(path => !scannedPaths.includes(path));
    
    modifiedDetected.forEach(path => {
      if (!modifiedGitFiles.includes(path)) {
        modifiedGitFiles.push(path);
      }
    });

    buildAndRenderTree(currentWorkspaceFiles, fileListDiv);
    
    let prefix = 'Workspace loaded';
    const currentStatus = statusDiv.textContent || '';
    if (currentStatus.includes('Fetch complete')) {
      prefix = 'Fetch complete';
    } else if (currentStatus.includes('Workspace loaded')) {
      prefix = 'Workspace loaded';
    }
    const totalChanges = modifiedGitFiles.length + deletedFiles.length;
    showStatus(`${prefix} (${totalChanges} changes found: ${modifiedGitFiles.length} mod/add, ${deletedFiles.length} del)`);
  } catch (err) {
    console.error(err);
    showStatus(`Diff check failed: ${err.message}`, true);
  } finally {
    loaderOverlay.style.display = 'none';
  }
}

// Bind modal listeners
if (closeDiffBtn) closeDiffBtn.addEventListener('click', closeDiffModal);
if (cancelSyncBtn) cancelSyncBtn.addEventListener('click', closeDiffModal);
if (confirmSyncBtn) confirmSyncBtn.addEventListener('click', confirmSyncFromModal);
window.addEventListener('click', (e) => {
  if (e.target === diffModal) {
    closeDiffModal();
  }
});

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
    deletedFiles = [];
    fileStates = {};
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
    detectAndRenderModifiedFiles(files);
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
    showStatus('Please click anywhere on the AI Studio page first, then try again.', true);
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
if (fullDiffBtn) {
  fullDiffBtn.addEventListener('click', runFullDiffScan);
}

if (gitAlertConfirmBtn) {
  gitAlertConfirmBtn.addEventListener('click', () => {
    if (gitTabAlertModal) {
      gitTabAlertModal.style.display = 'none';
    }
    const filesToScan = [...pendingGitAlertFiles];
    lastPromptedFilesStr = filesToScan.sort().join(',');
    runDiffScanForFiles(filesToScan);
  });
}

if (gitAlertCancelBtn) {
  gitAlertCancelBtn.addEventListener('click', () => {
    if (gitTabAlertModal) {
      gitTabAlertModal.style.display = 'none';
    }
    lastPromptedFilesStr = pendingGitAlertFiles.sort().join(',');
  });
}

tabLocal.addEventListener('click', () => setSourceMode('local'));
tabGitHub.addEventListener('click', () => setSourceMode('github'));
gitFetchBtn.addEventListener('click', fetchGitHubTree);
gitDetectBtn.addEventListener('click', autoDetectGit);

// Tab listeners to automatically update popup state when the active project or page changes
chrome.tabs.onActivated.addListener(() => {
  lastLoadedAppId = null;
  lastLoadedSourceMode = null;
  initWorkspace();
});

// Initialize on load
document.addEventListener('DOMContentLoaded', initWorkspace);

// Listen for progress updates from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'diffProgress') {
    const loaderMsg = document.getElementById('loaderMessage');
    if (loaderMsg) {
      loaderMsg.textContent = `Comparing ${message.current} of ${message.total} files...\n(${message.filePath.split('/').pop()})`;
    }
  } else if (message.action === 'gitTabOpenedWithChanges') {
    const changes = message.changes || [];
    if (changes.length > 0) {
      const changesStr = changes.sort().join(',');
      if (changesStr !== lastPromptedFilesStr) {
        const isBusy = (loaderOverlay && loaderOverlay.style.display === 'flex') || 
                       (diffModal && diffModal.style.display === 'flex') ||
                       (gitTabAlertModal && gitTabAlertModal.style.display === 'flex');
                       
        if (!isBusy) {
          pendingGitAlertFiles = changes;
          if (gitAlertCount) {
            gitAlertCount.textContent = changes.length;
          }
          if (gitTabAlertModal) {
            gitTabAlertModal.style.display = 'flex';
          }
        }
      }
    }
  }
});
