// Injected into the active tab to manipulate the DOM

console.log('Web Studio Syncer Content Script Loaded');

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'syncFile') {
    console.log(`Received file sync request for: ${request.fileName}`);
    handleSync(request.fileName, request.fileType, request.fileData);
  }
});

async function handleSync(fileName, fileType, fileDataBase64) {
  try {
    // Decode base64 back to array buffer / Blob
    const binaryString = atob(fileDataBase64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    const file = new File([bytes], fileName, { type: fileType });

    // Determine if it's a text file or binary based on type or extension
    const isText = fileType.startsWith('text/') || fileName.endsWith('.json') || fileName.endsWith('.js') || fileName.endsWith('.html') || fileName.endsWith('.css') || fileName.endsWith('.yml') || fileName.endsWith('.md');

    if (isText) {
      const text = await file.text();
      await updateWebEditor(text);
    } else {
      simulateFileDrop(file);
    }
  } catch (error) {
    console.error(`Error processing file ${fileName}:`, error);
  }
}

// Simulating an update to an open editor tab
async function updateWebEditor(newText) {
  // Common selectors for VS Code/Monaco and CodeMirror
  const editorTextArea = document.querySelector('.monaco-editor textarea, .cm-content'); 
  
  if (!editorTextArea) {
    console.warn('Could not find active editor text area. Please open the file in the Web IDE first.');
    return;
  }

  console.log('Found editor, injecting text...');
  editorTextArea.focus();
  
  // Select all existing text and replace via clipboard
  // Some IDEs need selection via command
  document.execCommand('selectAll');
  
  try {
    // navigator.clipboard requires HTTPS and active document focus.
    await navigator.clipboard.writeText(newText);
    document.execCommand('paste');
  } catch (e) {
    console.warn('Clipboard API failed, falling back to execCommand insertText', e);
    document.execCommand('insertText', false, newText);
  }

  // Simulate Ctrl+S (Save)
  const saveEvent = new KeyboardEvent('keydown', {
    key: 's',
    code: 'KeyS',
    ctrlKey: true,
    metaKey: true, // For Mac
    bubbles: true,
    cancelable: true
  });
  
  editorTextArea.dispatchEvent(saveEvent);
  console.log('Text injected and save command triggered.');
}

// Simulating dropping a file into the web IDE file explorer
function simulateFileDrop(file, dropZoneSelector = 'div[role="tree"], .explorer-folders-view, .file-explorer-container') {
  const dropZone = document.querySelector(dropZoneSelector);
  
  if (!dropZone) {
    console.warn(`Could not find file explorer drop zone matching selectors: ${dropZoneSelector}`);
    return;
  }

  console.log(`Simulating drop for file: ${file.name}`);

  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);

  const dropEvent = new DragEvent('drop', {
    bubbles: true,
    cancelable: true,
    dataTransfer: dataTransfer
  });

  // Some UI frameworks require dragenter and dragover before drop
  const dragEnterEvent = new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer });
  const dragOverEvent = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer });
  
  dropZone.dispatchEvent(dragEnterEvent);
  dropZone.dispatchEvent(dragOverEvent);
  dropZone.dispatchEvent(dropEvent);
  
  console.log('Drop event dispatched.');
}
