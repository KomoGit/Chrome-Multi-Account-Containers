// Chrome tab-group colors (the only colors Chrome can paint on a tab) -> hex for the popup.
const COLORS = { blue: '#1a73e8', cyan: '#007b83', green: '#188038', yellow: '#e37400', orange: '#fa7b17', red: '#d93025', pink: '#d01884', purple: '#9334e6', grey: '#5f6368' };
const ICONS = { fingerprint: '🆔', briefcase: '💼', dollar: '💵', cart: '🛒', circle: '⚪', gift: '🎁', vacation: '🏖️', food: '🍴', fruit: '🍎', pet: '🐾', tree: '🌳', chill: '🧊', fence: '🚧' };
const DEFAULT_CONTAINERS = [
  { id: 'personal', name: 'Personal', color: 'blue', icon: 'fingerprint' },
  { id: 'work', name: 'Work', color: 'orange', icon: 'briefcase' },
  { id: 'banking', name: 'Banking', color: 'green', icon: 'dollar' },
  { id: 'shopping', name: 'Shopping', color: 'pink', icon: 'cart' },
];
