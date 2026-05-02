const fs = require('fs');
const path = 'src\\app\\page.tsx';
let content = fs.readFileSync(path, 'utf8');

// Remove the auto-select block
const old = '      setSessions(loadedSessions));\n      if (loadedSessions.length > 0) {\n        setActiveSession(loadedSessions[0].id);\n        setMessages(loadedSessions[0].messages);\n        setHasStartedChat(true);\n      }\n    }\n  }, []);';
const newStr = '      // Load sessions for sidebar, but don\'t auto-select\n      // Let landing page show by default\n      setSessions(loadedSessions));\n    }\n  }, []);';

content = content.replace(old, newStr);
fs.writeFileSync(path, content, 'utf8');
console.log('Fixed!');
