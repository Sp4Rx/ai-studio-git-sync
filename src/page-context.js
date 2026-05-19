// This script runs in the MAIN world (page context)
// It has access to window.monaco directly.

console.log('AI Studio Git Sync Page-Context Script Loaded');

window.addEventListener('SyncFileToMonaco', async (event) => {
    const { fileName, fileText, autoSave } = event.detail;
    console.log(`Page Context: Received request to sync "${fileName}" to Monaco`);
    
    try {
      if (!window.monaco) {
        throw new Error("window.monaco is not defined on the page.");
      }
      
      // Wait up to 2 seconds for Monaco to load the correct file model
      let retries = 10;
      let activeEditor = null;
      let matched = false;
      
      while (retries > 0) {
        const editors = window.monaco.editor.getEditors();
        activeEditor = editors.find(e => e.getDomNode() && e.getDomNode().offsetParent !== null) || editors[0];
        
        if (activeEditor) {
          const model = activeEditor.getModel();
          if (model) {
            const uri = model.uri.toString();
            console.log(`Checking Monaco Model URI: ${uri} against filename: ${fileName}`);
            if (uri.endsWith(fileName) || uri.toLowerCase().includes(fileName.toLowerCase())) {
              matched = true;
              break;
            }
          }
        }
        retries--;
        await new Promise(r => setTimeout(r, 200));
      }
  
      if (!activeEditor) {
        throw new Error("Could not find visible Monaco editor instance.");
      }
  
      if (!matched) {
        console.warn(`Monaco model did not switch to "${fileName}" in time. Writing to active editor.`);
      }
  
      activeEditor.setValue(fileText);
      
      if (autoSave !== false) {
        // Simulate Ctrl+S on the editor's textarea or DOM node to trigger save listeners
        const domNode = activeEditor.getDomNode();
        const targetElement = domNode ? (domNode.querySelector('textarea') || domNode) : document.body;
        const saveEvent = new KeyboardEvent('keydown', {
          key: 's',
          code: 'KeyS',
          ctrlKey: true,
          metaKey: true,
          bubbles: true,
          cancelable: true
        });
        targetElement.dispatchEvent(saveEvent);
        console.log(`Page Context: Monaco editor updated and Ctrl+S dispatched for "${fileName}".`);
      } else {
        console.log(`Page Context: Monaco editor updated for "${fileName}". Auto-save disabled.`);
      }
    
    // Notify isolated content script of success
    window.dispatchEvent(new CustomEvent('SyncFileToMonacoResult', {
      detail: { success: true, fileName }
    }));
  } catch (err) {
    console.error('Page Context Error:', err);
    window.dispatchEvent(new CustomEvent('SyncFileToMonacoResult', {
      detail: { success: false, fileName, error: err.message }
    }));
  }
});

window.addEventListener('GetMonacoModels', () => {
  try {
    if (!window.monaco) {
      window.dispatchEvent(new CustomEvent('GetMonacoModelsResult', {
        detail: { success: false, error: 'window.monaco is not defined' }
      }));
      return;
    }
    const models = window.monaco.editor.getModels();
    const modelsData = models.map(m => ({
      uri: m.uri.toString(),
      value: m.getValue()
    }));
    window.dispatchEvent(new CustomEvent('GetMonacoModelsResult', {
      detail: { success: true, models: modelsData }
    }));
  } catch (err) {
    window.dispatchEvent(new CustomEvent('GetMonacoModelsResult', {
      detail: { success: false, error: err.message }
    }));
  }
});

window.addEventListener('GetActiveModelUri', () => {
  try {
    if (!window.monaco) {
      window.dispatchEvent(new CustomEvent('GetActiveModelUriResult', { detail: { uri: null } }));
      return;
    }
    const editors = window.monaco.editor.getEditors();
    const activeEditor = editors.find(e => e.getDomNode() && e.getDomNode().offsetParent !== null) || editors[0];
    if (activeEditor) {
      const model = activeEditor.getModel();
      if (model) {
        window.dispatchEvent(new CustomEvent('GetActiveModelUriResult', { detail: { uri: model.uri.toString() } }));
        return;
      }
    }
    window.dispatchEvent(new CustomEvent('GetActiveModelUriResult', { detail: { uri: null } }));
  } catch (e) {
    window.dispatchEvent(new CustomEvent('GetActiveModelUriResult', { detail: { uri: null } }));
  }
});

window.addEventListener('GetActiveModelContent', () => {
  try {
    if (!window.monaco) {
      window.dispatchEvent(new CustomEvent('GetActiveModelContentResult', { detail: { success: false, error: 'window.monaco is not defined' } }));
      return;
    }
    const editors = window.monaco.editor.getEditors();
    const activeEditor = editors.find(e => e.getDomNode() && e.getDomNode().offsetParent !== null) || editors[0];
    if (activeEditor) {
      const model = activeEditor.getModel();
      if (model) {
        window.dispatchEvent(new CustomEvent('GetActiveModelContentResult', { detail: { success: true, value: model.getValue() } }));
        return;
      }
    }
    window.dispatchEvent(new CustomEvent('GetActiveModelContentResult', { detail: { success: false, error: 'No active Monaco editor model' } }));
  } catch (err) {
    window.dispatchEvent(new CustomEvent('GetActiveModelContentResult', { detail: { success: false, error: err.message } }));
  }
});

window.addEventListener('SimulateFileDropMainWorld', async (event) => {
  try {
    const { targetId, fileName, fileType, fileDataBase64, filePath } = event.detail;
    
    const dropZone = document.getElementById(targetId);
    if (!dropZone) {
      console.warn('Page Context: Drop zone element not found by ID:', targetId);
      return;
    }

    console.log(`Page Context: Simulating drop for ${fileName} with path ${filePath} onto`, dropZone);

    const binaryString = atob(fileDataBase64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    const file = new File([bytes], fileName, { type: fileType });

    Object.defineProperty(file, 'webkitRelativePath', {
      get: () => filePath || fileName,
      configurable: true
    });

    const rect = dropZone.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;

    // Helper to build entry recursively
    const normalizedPath = (filePath || fileName).replace(/\\/g, '/').replace(/^\//, '');
    const parts = normalizedPath.split('/');

    function buildEntry(index) {
      const name = parts[index];
      const isLast = (index === parts.length - 1);
      const fullPath = '/' + parts.slice(0, index + 1).join('/');

      if (isLast) {
        // FileEntry
        return {
          isFile: true,
          isDirectory: false,
          name: name,
          fullPath: fullPath,
          file: (successCallback) => {
            if (successCallback) successCallback(file);
          }
        };
      } else {
        // DirectoryEntry
        const childEntry = buildEntry(index + 1);
        return {
          isFile: false,
          isDirectory: true,
          name: name,
          fullPath: fullPath,
          createReader: () => {
            let read = false;
            return {
              readEntries: (successCallback) => {
                if (!read) {
                  read = true;
                  successCallback([childEntry]);
                } else {
                  successCallback([]); // No more entries
                }
              }
            };
          }
        };
      }
    }

    const rootEntry = buildEntry(0);

    // Create custom mock DataTransferItem representing the root of the drop
    const mockItem = {
      kind: 'file',
      type: file.type,
      getAsFile: () => file,
      webkitGetAsEntry: () => rootEntry
    };

    const mockItems = [mockItem];
    mockItems.item = (idx) => mockItems[idx];

    const mockFiles = [file];
    mockFiles.item = (idx) => mockFiles[idx];

    const mockDataTransfer = {
      dropEffect: 'all',
      effectAllowed: 'all',
      types: ['Files'],
      files: mockFiles,
      items: mockItems
    };

    const enterTargets = [dropZone, document.body, window];
    for (const target of enterTargets) {
      if (!target) continue;
      const dragEnterEvent = new DragEvent('dragenter', { bubbles: true, cancelable: true, clientX, clientY });
      Object.defineProperty(dragEnterEvent, 'dataTransfer', { value: mockDataTransfer, configurable: true });
      const dragOverEvent = new DragEvent('dragover', { bubbles: true, cancelable: true, clientX, clientY });
      Object.defineProperty(dragOverEvent, 'dataTransfer', { value: mockDataTransfer, configurable: true });
      target.dispatchEvent(dragEnterEvent);
      target.dispatchEvent(dragOverEvent);
    }

    await new Promise(resolve => setTimeout(resolve, 100));

    const dropEvent = new DragEvent('drop', { bubbles: true, cancelable: true, clientX, clientY });
    Object.defineProperty(dropEvent, 'dataTransfer', { value: mockDataTransfer, configurable: true });
    dropZone.dispatchEvent(dropEvent);
    
    console.log('Page Context: Simulated drop event dispatched with directory entry structure.');
    
    // Cleanup temporary ID
    if (dropZone.id && dropZone.id.startsWith('ai-studio-git-sync-drop-')) {
      dropZone.removeAttribute('id');
    }
  } catch (err) {
    console.error('Page Context Simulate Drop Error:', err);
  }
});

