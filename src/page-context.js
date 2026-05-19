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
