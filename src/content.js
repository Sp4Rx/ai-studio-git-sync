// Injected into the active tab to manipulate the DOM (ISOLATED World)

console.log('AI Studio Git Sync Content Script Loaded');

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'syncFile') {
    const displayPath = request.filePath || request.fileName;
    console.log(`Received file sync request for: ${displayPath}`);
    handleSync(request.fileName, request.filePath, request.fileType, request.fileData, request.autoSave);
    sendResponse({ success: true });
  } else if (request.action === 'detectGit') {
    detectGitHubInfo().then(gitInfo => {
      sendResponse({ gitInfo });
    });
    return true; // Keep message channel open for async response
  } else if (request.action === 'getMonacoModels') {
    getMonacoModels().then(result => {
      sendResponse(result);
    });
    return true;
  } else if (request.action === 'getGitModifiedFiles') {
    getGitModifiedFiles(request.filePaths).then(modifiedFiles => {
      sendResponse({ modifiedFiles });
    });
    return true;
  } else if (request.action === 'getFileContent') {
    getFileContent(request.filePath).then(result => {
      sendResponse(result);
    });
    return true;
  } else if (request.action === 'compareAllFiles') {
    compareAllFiles(request.filePaths).then(result => {
      sendResponse(result);
    });
    return true;
  } else if (request.action === 'deleteFile') {
    deleteFileInTree(request.filePath).then(success => {
      sendResponse({ success });
    });
    return true;
  }
  return true;
});

async function getMonacoModels() {
  return new Promise((resolve) => {
    const handler = (event) => {
      window.removeEventListener('GetMonacoModelsResult', handler);
      resolve(event.detail);
    };
    window.addEventListener('GetMonacoModelsResult', handler);
    window.dispatchEvent(new CustomEvent('GetMonacoModels'));
    
    setTimeout(() => {
      window.removeEventListener('GetMonacoModelsResult', handler);
      resolve({ success: false, error: 'Timeout waiting for Monaco models' });
    }, 1000);
  });
}

function getRelativePathFromMonacoUri(uri) {
  if (!uri) return null;
  let path = uri;
  if (path.includes('://')) {
    path = path.substring(path.indexOf('://') + 3);
  }
  path = path.replace(/^model\/\d+\//i, '');
  path = path.replace(/^model\//i, '');
  path = path.replace(/^\/+/, '');
  return path;
}

async function getFileContent(filePath) {
  const openModels = await getMonacoModels();
  if (openModels && openModels.success && openModels.models) {
    const relPath = filePath.toLowerCase().replace(/\\/g, '/');
    const matched = openModels.models.find(m => {
      const uriStr = m.uri.toLowerCase().replace(/\\/g, '/');
      return uriStr.endsWith('/' + relPath) || uriStr.endsWith('model/' + relPath) || uriStr === relPath;
    });
    if (matched) {
      console.log(`File ${filePath} is already loaded in Monaco.`);
      return { success: true, content: matched.value, isLoaded: true };
    }
  }

  console.log(`File ${filePath} is not open. Querying active tab URI to save state...`);
  let activeUri = null;
  try {
    activeUri = await new Promise((resolve) => {
      const handler = (event) => {
        window.removeEventListener('GetActiveModelUriResult', handler);
        resolve(event.detail.uri);
      };
      window.addEventListener('GetActiveModelUriResult', handler);
      window.dispatchEvent(new CustomEvent('GetActiveModelUri'));
      setTimeout(() => {
        window.removeEventListener('GetActiveModelUriResult', handler);
        resolve(null);
      }, 500);
    });
  } catch (e) {
    console.warn('Failed to get active model URI:', e);
  }

  console.log(`Opening file: ${filePath}`);
  const opened = await openFileInTree(filePath);
  if (!opened) {
    return { success: false, error: 'File not found in AI Studio workspace tree' };
  }

  let content = '';
  try {
    content = await new Promise((resolve, reject) => {
      const handler = (event) => {
        window.removeEventListener('GetActiveModelContentResult', handler);
        if (event.detail.success) {
          resolve(event.detail.value);
        } else {
          reject(new Error(event.detail.error));
        }
      };
      window.addEventListener('GetActiveModelContentResult', handler);
      window.dispatchEvent(new CustomEvent('GetActiveModelContent'));
      setTimeout(() => {
        window.removeEventListener('GetActiveModelContentResult', handler);
        reject(new Error('Timeout waiting for Monaco model value'));
      }, 1000);
    });
  } catch (e) {
    return { success: false, error: `Failed to read file content: ${e.message}` };
  }

  if (activeUri) {
    const originalPath = getRelativePathFromMonacoUri(activeUri);
    if (originalPath && originalPath !== filePath) {
      console.log(`Restoring original active file: ${originalPath}`);
      await openFileInTree(originalPath);
    }
  }

  return { success: true, content, isLoaded: false };
}

async function getGitModifiedFiles(filePaths) {
  if (!filePaths || filePaths.length === 0) return [];
  console.log(`Scanning for modified files among ${filePaths.length} workspace files...`);

  // Find and click GitHub tab to render the changes pane
  const buttons = Array.from(document.querySelectorAll('button, a, div[role="tab"], .mat-tab-label, .mat-focus-indicator, mat-tab-header div'));
  const githubTab = buttons.find(b => {
    const text = b.textContent.toLowerCase();
    return text.includes('github') || text.includes('git hub') || text.includes('sync to github');
  });

  let activeTab = null;
  if (githubTab) {
    activeTab = buttons.find(b => {
      if (b === githubTab) return false;
      return b.classList.contains('active') || 
             b.classList.contains('selected') || 
             b.getAttribute('aria-selected') === 'true' ||
             b.className.includes('active') ||
             b.className.includes('selected') ||
             b.className.includes('mat-tab-label-active') ||
             b.className.includes('mat-mdc-tab-active');
    });

    try {
      githubTab.click();
      await new Promise(r => setTimeout(r, 400)); // wait for panel rendering
    } catch (e) {
      console.warn('Failed to switch to GitHub tab:', e);
    }
  }

  const modified = [];
  try {
    const statusLabels = Array.from(document.querySelectorAll('span, div, p, badge, mat-chip'));
    const gitStatuses = ['Modified', 'Added', 'Deleted', 'Untracked', 'modified', 'added', 'deleted', 'untracked'];
    
    const detectedPaths = [];
    for (const label of statusLabels) {
      if (label.offsetParent === null) continue; // Must be visible
      const labelText = label.textContent ? label.textContent.trim() : '';
      if (gitStatuses.includes(labelText)) {
        let container = label.parentElement;
        
        for (let depth = 0; depth < 3; depth++) {
          if (!container || container === document.body) break;
          const text = container.textContent ? container.textContent.trim() : '';
          
          let cleaned = text
            .replace(labelText, '')
            .replace(/[\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD00-\uDFFF]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
            
          const matchedPath = filePaths.find(path => {
            const relPath = path.replace(/\\/g, '/');
            return cleaned === relPath || cleaned.endsWith('/' + relPath) || cleaned.endsWith(relPath);
          });
          
          if (matchedPath) {
            detectedPaths.push(matchedPath);
            break;
          }
          container = container.parentElement;
        }
      }
    }
    
    const uniquePaths = [...new Set(detectedPaths)];
    modified.push(...uniquePaths);
  } catch (err) {
    console.error('Error scanning modified files in DOM:', err);
  }

  // Restore the original tab if we switched it
  if (githubTab && activeTab) {
    try {
      activeTab.click();
    } catch (e) {
      console.warn('Failed to restore original tab:', e);
    }
  }

  console.log(`Detected modified files:`, modified);
  return modified;
}

async function detectGitHubInfo() {
  const regex = /([\w\-\.]+)\/([\w\-\.]+) on ([\w\-\.\/]+)/;

  function scanDOM() {
    const elements = document.querySelectorAll('a, button, span, div, p, h1, h2, h3');
    for (const el of elements) {
      const text = el.textContent ? el.textContent.trim() : '';
      const match = text.match(regex);
      if (match) {
        const repo = `${match[1]}/${match[2]}`;
        const branch = match[3].split(/\s+/)[0];
        return { repo, branch };
      }
    }
    
    const bodyText = document.body.innerText || '';
    const multiLineRegex = /([\w\-\.]+)\/([\w\-\.]+)\s+on\s+([\w\-\.\/]+)/i;
    const multiLineMatch = bodyText.match(multiLineRegex);
    if (multiLineMatch) {
      const repo = `${multiLineMatch[1]}/${multiLineMatch[2]}`;
      const branch = multiLineMatch[3].split(/\s+/)[0];
      return { repo, branch };
    }
    return null;
  }

  // 1. Passive scan first
  let gitInfo = scanDOM();
  if (gitInfo) {
    console.log(`Content Script: Passively detected Git settings:`, gitInfo);
    return gitInfo;
  }

  // 2. Active scan: Find and click GitHub tab, scrape, and restore
  console.log(`Content Script: Passive detection failed. Attempting active tab switching...`);
  const buttons = Array.from(document.querySelectorAll('button, a, div[role="tab"], .mat-tab-label, .mat-focus-indicator, mat-tab-header div'));
  
  const githubTab = buttons.find(b => {
    const text = b.textContent.toLowerCase();
    return text.includes('github') || text.includes('git hub') || text.includes('sync to github');
  });

  if (githubTab) {
    console.log(`Content Script: Found GitHub tab button. Locating active tab...`);
    const activeTab = buttons.find(b => {
      if (b === githubTab) return false;
      return b.classList.contains('active') || 
             b.classList.contains('selected') || 
             b.getAttribute('aria-selected') === 'true' ||
             b.className.includes('active') ||
             b.className.includes('selected') ||
             b.className.includes('mat-tab-label-active') ||
             b.className.includes('mat-mdc-tab-active');
    });

    try {
      githubTab.click();
      await new Promise(r => setTimeout(r, 300)); // wait for panel rendering
      
      gitInfo = scanDOM();
      
      if (activeTab) {
        activeTab.click();
      } else {
        // Toggle/close drawer
        githubTab.click();
      }
      
      if (gitInfo) {
        console.log(`Content Script: Actively detected Git settings:`, gitInfo);
        return gitInfo;
      }
    } catch (e) {
      console.error(`Content Script: Error during active Git detection:`, e);
    }
  }

  return null;
}


async function handleSync(fileName, filePath, fileType, fileDataBase64, autoSave) {
  try {
    // Decode base64 back to array buffer / Blob
    const binaryString = atob(fileDataBase64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    const file = new File([bytes], fileName, { type: fileType });

    // Determine if it's a text/code file
    const isText = fileType.startsWith('text/') || 
                   fileName.endsWith('.json') || 
                   fileName.endsWith('.js') || 
                   fileName.endsWith('.ts') || 
                   fileName.endsWith('.tsx') || 
                   fileName.endsWith('.html') || 
                   fileName.endsWith('.css') || 
                   fileName.endsWith('.yml') || 
                   fileName.endsWith('.yaml') || 
                   fileName.endsWith('.md');

    if (isText && filePath) {
      console.log(`Text file detected: ${filePath}`);
      console.log(`Attempting to open existing file: ${filePath}`);
      const opened = await openFileInTree(filePath);
      
      if (!opened) {
        console.log(`File not found in tree. Attempting to upload via drop...`);
        // Fall back to drag and drop to upload new files
        await simulateFileDrop(file, filePath);
        
        if (autoSave) {
          // Wait 1.5s for the app to register the drop and render files
          await new Promise(r => setTimeout(r, 1500));
          const openedNew = await openFileInTree(filePath);
          if (!openedNew) {
            console.warn("Could not open newly created file in tree after drop.");
          }
          triggerWorkspaceSave();
        } else {
          console.log('Auto-save is disabled. Skipping save for new file upload.');
        }
        return;
      }
      
      const text = await file.text();
      await updateWebEditorWithFallback(fileName, text, autoSave);
      
      if (autoSave) {
        // Auto-click the bottom workspace "Save" button if it appears
        triggerWorkspaceSave();
      } else {
        console.log('Auto-save is disabled. Skipping workspace save click.');
      }
    } else {
      console.log('Binary file or no path. Simulating drag and drop upload...');
      await simulateFileDrop(file, filePath);
      if (autoSave) {
        await new Promise(r => setTimeout(r, 1500));
        triggerWorkspaceSave();
      }
    }
  } catch (error) {
    console.error(`Error processing file ${filePath || fileName}:`, error);
  }
}

function getNodeTextWithoutIcons(node) {
  const clone = node.cloneNode(true);
  const icons = clone.querySelectorAll('mat-icon, .mat-icon, .icon, .tree-icon, svg, [aria-hidden="true"]');
  icons.forEach(icon => icon.remove());
  return clone.textContent.replace(/\s+/g, ' ').trim();
}

// Navigates the File Explorer tree view to find and open the file
// Returns true if successful, false if not found.
async function openFileInTree(filePath) {
  const parts = filePath.split('/'); // e.g. ["src", "components", "Button.tsx"]
  let parentIndex = -1;
  let currentLevel = 1;

  for (let i = 0; i < parts.length; i++) {
    const segment = parts[i];
    const isLast = (i === parts.length - 1);
    currentLevel = i + 1;
    
    console.log(`Navigating tree segment: "${segment}" (level: ${currentLevel})`);
    
    // Find all visible tree nodes
    const nodes = Array.from(document.querySelectorAll('mat-tree-node, [role="treeitem"]'));
    
    // Search for the matching child node at this level, located after parentIndex
    let targetIndex = -1;
    for (let j = 0; j < nodes.length; j++) {
      if (j <= parentIndex) continue; // Must be below/after the parent folder node
      
      const node = nodes[j];
      const levelAttr = node.getAttribute('aria-level');
      const level = levelAttr ? parseInt(levelAttr, 10) : 1;
      
      // If we hit a node with a level lower than currentLevel, we've exited the parent folder's list!
      if (i > 0 && level < currentLevel) {
        break; 
      }
      
      if (level === currentLevel) {
        const nodeText = getNodeTextWithoutIcons(node);
        const nameMatches = nodeText === segment || 
                            nodeText.includes(segment) ||
                            nodeText.endsWith(`/${segment}`);
                            
        if (nameMatches) {
          targetIndex = j;
          break;
        }
      }
    }

    if (targetIndex === -1) {
      console.log(`Segment "${segment}" at level ${currentLevel} not found in tree.`);
      return false;
    }

    const targetNode = nodes[targetIndex];
    parentIndex = targetIndex; // Update parent tracker

    if (isLast) {
      console.log(`Clicking file node to open: ${segment}`);
      targetNode.click();
      // Wait for editor tab to load using active model polling
      await waitForActiveModelChange(filePath, 600);
    } else {
      // Check if folder is expanded
      const isExpandedAttr = targetNode.getAttribute('aria-expanded');
      let isExpanded = isExpandedAttr === 'true';
      if (isExpandedAttr === null) {
        isExpanded = targetNode.className.includes('expanded') || 
                     !!targetNode.querySelector('.mat-tree-node-expanded, .expanded');
      }

      if (!isExpanded) {
        console.log(`Expanding folder: ${segment}`);
        targetNode.click();
        // Wait for children to mount in DOM
        await new Promise(resolve => setTimeout(resolve, 500));
      } else {
        console.log(`Folder already expanded: ${segment}`);
      }
    }
  }
  return true;
}

// Update editor by communicating with the MAIN world page-context script (bypassing CSP)
async function updateWebEditorWithFallback(fileName, newText, autoSave) {
  try {
    console.log('Attempting MAIN world page-context Monaco update...');
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        window.removeEventListener('SyncFileToMonacoResult', handler);
        reject(new Error("Timeout waiting for page-context script response."));
      }, 3000);
      
      const handler = (event) => {
        if (event.detail.fileName === fileName) {
          clearTimeout(timeout);
          window.removeEventListener('SyncFileToMonacoResult', handler);
          if (event.detail.success) {
            resolve();
          } else {
            reject(new Error(event.detail.error));
          }
        }
      };
      
      window.addEventListener('SyncFileToMonacoResult', handler);
      
      window.dispatchEvent(new CustomEvent('SyncFileToMonaco', {
        detail: { fileName, fileText: newText, autoSave }
      }));
    });
    console.log('Monaco page-context update succeeded.');
  } catch (err) {
    console.warn(`Monaco API update failed: ${err.message}. Falling back to DOM injection...`);
    await updateWebEditorDOM(newText, autoSave);
  }
}

// Fallback DOM-based injection
async function updateWebEditorDOM(newText, autoSave) {
  const editorTextArea = document.querySelector('.monaco-editor textarea, .cm-content, textarea.ace_text-input, [role="textbox"][aria-multiline="true"]'); 
  
  if (!editorTextArea) {
    throw new Error('Could not find active editor text area.');
  }

  console.log('DOM Injection: Found editor, injecting text...');
  
  window.focus();
  editorTextArea.focus();
  document.execCommand('selectAll');
  
  try {
    if (document.hasFocus()) {
      await navigator.clipboard.writeText(newText);
      document.execCommand('paste');
    } else {
      document.execCommand('insertText', false, newText);
    }
  } catch (e) {
    document.execCommand('insertText', false, newText);
  }

  if (autoSave !== false) {
    const saveEvent = new KeyboardEvent('keydown', {
      key: 's',
      code: 'KeyS',
      ctrlKey: true,
      metaKey: true,
      bubbles: true,
      cancelable: true
    });
    
    editorTextArea.dispatchEvent(saveEvent);
    console.log('Ctrl+S dispatched.');
  } else {
    console.log('Auto-save disabled. Skipping DOM Ctrl+S dispatch.');
  }
}

// Auto-clicks the workspace "Save" button in the bottom commit/change toolbar (with polling)
function triggerWorkspaceSave() {
  let retries = 15; // Poll for up to 3 seconds (15 * 200ms)
  const interval = setInterval(() => {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    const saveBtn = buttons.find(btn => {
      const text = btn.textContent.trim();
      return text === 'Save' || text === 'save';
    });
    
    if (saveBtn) {
      console.log('Found workspace Save button. Auto-clicking...');
      saveBtn.click();
      clearInterval(interval);
    } else {
      retries--;
      if (retries <= 0) {
        console.log('Workspace Save button not found after polling.');
        clearInterval(interval);
      }
    }
  }, 200);
}

async function navigateToFolder(folderPath) {
  if (!folderPath) return null;
  const parts = folderPath.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  
  let parentIndex = -1;
  let currentLevel = 1;
  let targetNode = null;

  for (let i = 0; i < parts.length; i++) {
    const segment = parts[i];
    currentLevel = i + 1;
    
    // Find all visible tree nodes
    const nodes = Array.from(document.querySelectorAll('mat-tree-node, [role="treeitem"]'));
    let targetIndex = -1;
    
    for (let j = 0; j < nodes.length; j++) {
      if (j <= parentIndex) continue;
      
      const node = nodes[j];
      const levelAttr = node.getAttribute('aria-level');
      const level = levelAttr ? parseInt(levelAttr, 10) : 1;
      
      if (i > 0 && level < currentLevel) {
        break;
      }
      
      if (level === currentLevel) {
        const nodeText = getNodeTextWithoutIcons(node);
        const nameMatches = nodeText === segment || 
                            nodeText.includes(segment) ||
                            nodeText.endsWith(`/${segment}`);
                            
        if (nameMatches) {
          targetIndex = j;
          break;
        }
      }
    }

    if (targetIndex === -1) {
      console.log(`Folder segment "${segment}" at level ${currentLevel} not found in tree.`);
      return null;
    }

    targetNode = nodes[targetIndex];
    parentIndex = targetIndex;

    const isLastFolderSegment = (i === parts.length - 1);
    if (!isLastFolderSegment) {
      const isExpandedAttr = targetNode.getAttribute('aria-expanded');
      let isExpanded = isExpandedAttr === 'true';
      if (isExpandedAttr === null) {
        isExpanded = targetNode.className.includes('expanded') || 
                     !!targetNode.querySelector('.mat-tree-node-expanded, .expanded');
      }

      if (!isExpanded) {
        console.log(`Expanding folder: ${segment}`);
        targetNode.click();
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  }

  return targetNode;
}

// Simulating dropping a file into the web IDE file explorer
async function simulateFileDrop(file, filePath) {
  let dropZone = null;

  let folderPath = '';
  if (filePath && filePath.includes('/')) {
    folderPath = filePath.substring(0, filePath.lastIndexOf('/'));
  }

  if (folderPath) {
    console.log(`Attempting to locate folder node for drop zone: ${folderPath}`);
    try {
      const folderNode = await navigateToFolder(folderPath);
      if (folderNode) {
        dropZone = folderNode;
        console.log(`Found nested folder node to drop onto:`, folderNode);
      }
    } catch (e) {
      console.warn('Failed to navigate folder for drop:', e);
    }
  }

  if (!dropZone) {
    // Find the container displaying existing project files
    const commonFiles = ['.gitignore', 'package.json', '.env.example', 'tsconfig.json', 'metadata.json'];
    for (const filename of commonFiles) {
      const fileElements = Array.from(document.querySelectorAll('div, span, a, p, li'));
      const matchedElement = fileElements.find(el => el.textContent.trim() === filename);
      if (matchedElement) {
        let parent = matchedElement.parentElement;
        while (parent && parent !== document.body) {
          const role = parent.getAttribute('role');
          const tagName = parent.tagName.toLowerCase();
          const className = parent.className || '';
          
          // Skip individual leaf nodes so we don't drop on item nodes
          if (role === 'treeitem' || tagName === 'mat-tree-node') {
            parent = parent.parentElement;
            continue;
          }
          
          if (role === 'tree' || 
              tagName === 'mat-tree' ||
              tagName === 'cdk-tree' ||
              className.includes('explorer') || 
              className.includes('sidebar') ||
              parent.scrollHeight > parent.clientHeight) {
            dropZone = parent;
            break;
          }
          parent = parent.parentElement;
        }
        if (dropZone) break;
      }
    }
  }

  if (!dropZone) {
    const dropZoneSelectors = ['project-file-explorer', 'file-tree', '.file-explorer', 'div[role="tree"]'];
    for (const selector of dropZoneSelectors) {
      const el = document.querySelector(selector);
      if (el) {
        dropZone = el;
        break;
      }
    }
  }

  if (!dropZone) {
    dropZone = document.body;
  }

  console.log(`Simulating drop for file: ${file.name} onto target:`, dropZone);

  // Get coordinates in center of dropzone
  const rect = dropZone.getBoundingClientRect();
  const clientX = rect.left + rect.width / 2;
  const clientY = rect.top + rect.height / 2;

  // Setup the mock DataTransfer object
  const dataTransfer = new DataTransfer();
  try {
    dataTransfer.items.add(file);
  } catch (e) {}

  // Override properties to satisfy Angular CDK checks
  Object.defineProperty(dataTransfer, 'types', {
    get: () => ['Files'],
    configurable: true
  });
  
  const fileList = [file];
  fileList.item = (idx) => fileList[idx];
  Object.defineProperty(dataTransfer, 'files', {
    get: () => fileList,
    configurable: true
  });

  // Mock webkitGetAsEntry to support entry-based tree parsing (used for file structure drops)
  if (dataTransfer.items && dataTransfer.items.length > 0) {
    const item = dataTransfer.items[0];
    
    Object.defineProperty(item, 'kind', { get: () => 'file', configurable: true });
    Object.defineProperty(item, 'type', { get: () => file.type, configurable: true });
    
    Object.defineProperty(item, 'webkitGetAsEntry', {
      value: () => {
        return {
          isFile: true,
          isDirectory: false,
          name: file.name,
          fullPath: '/' + (filePath || file.name),
          file: (successCallback) => {
            if (successCallback) successCallback(file);
          }
        };
      },
      configurable: true
    });
  }

  // 1. Dispatch DragEnter and DragOver first (this often triggers dynamic dropzone overlays / file inputs)
  const enterTargets = [dropZone, document.body, window];
  for (const target of enterTargets) {
    if (!target) continue;
    const dragEnterEvent = new DragEvent('dragenter', { bubbles: true, cancelable: true, clientX, clientY });
    Object.defineProperty(dragEnterEvent, 'dataTransfer', { value: dataTransfer, configurable: true });
    const dragOverEvent = new DragEvent('dragover', { bubbles: true, cancelable: true, clientX, clientY });
    Object.defineProperty(dragOverEvent, 'dataTransfer', { value: dataTransfer, configurable: true });
    
    target.dispatchEvent(dragEnterEvent);
    target.dispatchEvent(dragOverEvent);
  }

  // 2. Wait 100ms for any dynamic DOM changes (e.g. dropzone overlays or hidden inputs appearing)
  await new Promise(resolve => setTimeout(resolve, 100));

  // 3. Search for file inputs as a backup (some dropzones dynamically insert input[type="file"])
  // Only execute this backup for root drops (when folderPath is empty) to avoid uploading nested files to root!
  if (!folderPath) {
    const fileInputs = Array.from(document.querySelectorAll('input[type="file"]'));
    console.log(`Diagnostic: Found ${fileInputs.length} file inputs on the page:`, fileInputs);
    
    if (fileInputs.length > 0) {
      console.log('Backup: Attempting upload using standard file inputs...');
      for (const input of fileInputs) {
        try {
          const cleanDt = new DataTransfer();
          cleanDt.items.add(file);
          input.files = cleanDt.files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          console.log('Dispatched change event to file input.');
        } catch (err) {
          console.warn('Failed to assign file to input:', err);
        }
      }
    }
  } else {
    console.log('Nested folder target: Skipping standard file input backup to prevent root upload.');
  }

  // 4. Dispatch the final drop event ONLY to the specific dropZone (and let it bubble naturally)
  console.log(`Simulating drop on folder dropZone:`, dropZone);
  const dropEvent = new DragEvent('drop', { bubbles: true, cancelable: true, clientX, clientY });
  Object.defineProperty(dropEvent, 'dataTransfer', { value: dataTransfer, configurable: true });
  dropZone.dispatchEvent(dropEvent);
  
  console.log('Drop event dispatched to target dropZone.');
}

async function waitForActiveModelChange(targetPath, timeout = 600) {
  const startTime = Date.now();
  const relPath = targetPath.toLowerCase().replace(/\\/g, '/');
  
  while (Date.now() - startTime < timeout) {
    const activeUri = await new Promise((resolve) => {
      const handler = (event) => {
        window.removeEventListener('GetActiveModelUriResult', handler);
        resolve(event.detail.uri);
      };
      window.addEventListener('GetActiveModelUriResult', handler);
      window.dispatchEvent(new CustomEvent('GetActiveModelUri'));
      setTimeout(() => {
        window.removeEventListener('GetActiveModelUriResult', handler);
        resolve(null);
      }, 100);
    });
    
    if (activeUri) {
      const currentPath = getRelativePathFromMonacoUri(activeUri);
      if (currentPath) {
        const curLow = currentPath.toLowerCase();
        if (curLow === relPath || curLow.endsWith('/' + relPath)) {
          console.log(`Model successfully switched to: ${targetPath} in ${Date.now() - startTime}ms`);
          return true;
        }
      }
    }
    await new Promise(r => setTimeout(r, 50));
  }
  return false;
}

async function compareAllFiles(filePaths) {
  console.log(`Initiating sequential workspace comparison of ${filePaths.length} files...`);
  
  try {
    await expandAllTreeFolders();
  } catch (err) {
    console.warn('Failed to expand all tree folders:', err);
  }
  
  let activeUri = null;
  try {
    activeUri = await new Promise((resolve) => {
      const handler = (event) => {
        window.removeEventListener('GetActiveModelUriResult', handler);
        resolve(event.detail.uri);
      };
      window.addEventListener('GetActiveModelUriResult', handler);
      window.dispatchEvent(new CustomEvent('GetActiveModelUri'));
      setTimeout(() => {
        window.removeEventListener('GetActiveModelUriResult', handler);
        resolve(null);
      }, 300);
    });
  } catch (e) {
    console.warn('Failed to get active model URI:', e);
  }

  const results = {};
  
  let index = 0;
  for (const filePath of filePaths) {
    index++;
    console.log(`Scanning: ${filePath}`);
    try {
      chrome.runtime.sendMessage({
        action: 'diffProgress',
        current: index,
        total: filePaths.length,
        filePath
      }).catch(() => {});
    } catch (e) {}
    
    try {
      const openModels = await getMonacoModels();
      let content = null;
      let isFound = false;
      
      if (openModels && openModels.success && openModels.models) {
        const relPath = filePath.toLowerCase().replace(/\\/g, '/');
        const matched = openModels.models.find(m => {
          const uriStr = m.uri.toLowerCase().replace(/\\/g, '/');
          return uriStr.endsWith('/' + relPath) || uriStr.endsWith('model/' + relPath) || uriStr === relPath;
        });
        if (matched) {
          content = matched.value;
          isFound = true;
          console.log(`File ${filePath} found in open Monaco models.`);
        }
      }
      
      if (!isFound) {
        const opened = await openFileInTree(filePath);
        if (opened) {
          content = await new Promise((resolve) => {
            const handler = (event) => {
              window.removeEventListener('GetActiveModelContentResult', handler);
              if (event.detail.success) resolve(event.detail.value);
              else resolve(null);
            };
            window.addEventListener('GetActiveModelContentResult', handler);
            window.dispatchEvent(new CustomEvent('GetActiveModelContent'));
            setTimeout(() => {
              window.removeEventListener('GetActiveModelContentResult', handler);
              resolve(null);
            }, 600);
          });
          isFound = true;
        }
      }
      
      if (isFound && content !== null) {
        results[filePath] = { status: 'found', content };
      } else {
        results[filePath] = { status: 'not_found' };
      }
    } catch (err) {
      console.warn(`Error scanning file ${filePath}:`, err);
      results[filePath] = { status: 'error', error: err.message };
    }
  }
  
  if (activeUri) {
    const originalPath = getRelativePathFromMonacoUri(activeUri);
    if (originalPath) {
      console.log(`Restoring original active file: ${originalPath}`);
      await openFileInTree(originalPath);
    }
  }
  
  let studioFiles = [];
  try {
    studioFiles = getAllStudioFiles();
  } catch (err) {
    console.warn('Failed to scan studio file tree:', err);
  }
  
  return { success: true, results, studioFiles };
}

async function expandAllTreeFolders() {
  console.log('Expanding all tree folders programmatically...');
  let newlyExpanded = true;
  let safetyLoop = 0;
  
  while (newlyExpanded && safetyLoop < 15) {
    newlyExpanded = false;
    safetyLoop++;
    const nodes = Array.from(document.querySelectorAll('mat-tree-node, [role="treeitem"]'));
    for (const node of nodes) {
      const isExpandedAttr = node.getAttribute('aria-expanded');
      let isExpanded = isExpandedAttr === 'true';
      if (isExpandedAttr === null) {
        isExpanded = node.className.includes('expanded') || 
                     !!node.querySelector('.mat-tree-node-expanded, .expanded');
      }
      
      const isFolder = node.hasAttribute('aria-expanded') || 
                       node.className.includes('folder') || 
                       node.querySelector('.mat-icon-folder') ||
                       node.querySelector('span[style*="folder"]') || 
                       !!node.querySelector('.mat-tree-node-expanded, .mat-tree-node-collapsed') ||
                       node.getAttribute('aria-expanded') !== null;
                       
      if (isFolder && !isExpanded) {
        console.log('Expanding folder during scanner:', getNodeTextWithoutIcons(node));
        node.click();
        newlyExpanded = true;
        await new Promise(r => setTimeout(r, 250));
      }
    }
  }
  console.log('Tree folders expansion complete.');
}

function getAllStudioFiles() {
  const nodes = Array.from(document.querySelectorAll('mat-tree-node, [role="treeitem"]'));
  const files = [];
  const pathStack = [];
  
  for (const node of nodes) {
    const levelAttr = node.getAttribute('aria-level');
    const level = levelAttr ? parseInt(levelAttr, 10) : 1;
    const name = getNodeTextWithoutIcons(node);
    
    if (!name) continue;
    
    pathStack.length = level - 1;
    
    const isFolder = node.hasAttribute('aria-expanded') || 
                     node.className.includes('folder') || 
                     node.querySelector('.mat-icon-folder') ||
                     node.querySelector('span[style*="folder"]') || 
                     !!node.querySelector('.mat-tree-node-expanded, .mat-tree-node-collapsed') ||
                     node.getAttribute('aria-expanded') !== null;
                     
    if (isFolder) {
      pathStack.push(name);
    } else {
      const relativePath = pathStack.length > 0 ? `${pathStack.join('/')}/${name}` : name;
      files.push(relativePath);
    }
  }
  console.log('Scanned files in AI Studio:', files);
  return files;
}

async function deleteFileInTree(filePath) {
  console.log(`Attempting to delete file in tree: ${filePath}`);
  try {
    const opened = await openFileInTree(filePath);
    if (!opened) {
      console.warn(`Could not open file ${filePath} to delete.`);
      return false;
    }
    
    const nodes = Array.from(document.querySelectorAll('mat-tree-node, [role="treeitem"]'));
    const parts = filePath.split('/');
    const segment = parts[parts.length - 1];
    const currentLevel = parts.length;
    
    let targetNode = null;
    for (const node of nodes) {
      const levelAttr = node.getAttribute('aria-level');
      const level = levelAttr ? parseInt(levelAttr, 10) : 1;
      if (level === currentLevel) {
        const nodeText = getNodeTextWithoutIcons(node);
        if (nodeText === segment || nodeText.includes(segment)) {
          targetNode = node;
          break;
        }
      }
    }
    
    if (!targetNode) {
      console.warn(`Target node for delete not found: ${segment}`);
      return false;
    }
    
    const menuBtn = targetNode.querySelector('button, [role="button"], .mat-icon-button, [aria-haspopup="true"]');
    if (!menuBtn) {
      console.warn('Three-dot menu button not found on tree node.');
      return false;
    }
    
    console.log('Clicking three-dot menu button...');
    menuBtn.click();
    await new Promise(r => setTimeout(r, 400));
    
    const menuItems = Array.from(document.querySelectorAll('.cdk-overlay-container button, .mat-menu-item, [role="menuitem"]'));
    const deleteItem = menuItems.find(item => item.textContent.toLowerCase().includes('delete'));
    if (!deleteItem) {
      console.warn('Delete item not found in dropdown menu.');
      return false;
    }
    
    console.log('Clicking Delete menu item...');
    deleteItem.click();
    await new Promise(r => setTimeout(r, 500));
    
    const dialogButtons = Array.from(document.querySelectorAll('mat-dialog-container button, button, .mat-button, .mat-mdc-button'));
    const confirmBtn = dialogButtons.find(btn => 
      btn.textContent.toLowerCase().includes('delete') || 
      btn.textContent.toLowerCase().includes('confirm') || 
      btn.textContent.toLowerCase().includes('ok') ||
      btn.textContent.toLowerCase().includes('yes')
    );
    
    if (confirmBtn) {
      console.log('Clicking confirm button in dialog modal...');
      confirmBtn.click();
      await new Promise(r => setTimeout(r, 500));
    }
    
    console.log(`File ${filePath} deleted successfully.`);
    return true;
  } catch (err) {
    console.error(`Error deleting file ${filePath}:`, err);
    return false;
  }
}
