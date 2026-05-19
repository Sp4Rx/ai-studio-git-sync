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
  }
  return true;
});

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
      // Wait for editor tab to load
      await new Promise(resolve => setTimeout(resolve, 850));
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

// Simulating dropping a file into the web IDE file explorer
async function simulateFileDrop(file, filePath) {
  let dropZone = null;

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

  // 4. Dispatch the final drop event to all targets
  for (const target of enterTargets) {
    if (!target) continue;
    const dropEvent = new DragEvent('drop', { bubbles: true, cancelable: true, clientX, clientY });
    Object.defineProperty(dropEvent, 'dataTransfer', { value: dataTransfer, configurable: true });
    target.dispatchEvent(dropEvent);
  }
  
  console.log('Drop events dispatched to all targets.');
}
