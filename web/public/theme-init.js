// Apply only an explicit preference; dark is the design-system default.
try { document.documentElement.dataset.theme = localStorage.getItem('ans:theme') === 'light' ? 'light' : 'dark'; }
catch { document.documentElement.dataset.theme = 'dark'; }
