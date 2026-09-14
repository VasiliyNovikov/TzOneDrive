export const SLIDESHOW_INTERVAL_MS = 5000;

export function initialState() {
  return {
    screen: 'diagnostics',
    returnScreen: 'folders',
    folders: [],
    folderId: null,
    photos: [],
    photoIndex: 0,
    playing: false,
    loading: true,
    error: null,
    lastKey: 'No input yet',
    cameraChallenge: '',
  };
}

export function reduce(state, action) {
  switch (action.type) {
    case 'KEY':
      return { ...state, lastKey: String(action.label).slice(0, 100) };
    case 'CHALLENGE_DIGIT':
      if (typeof action.digit !== 'string' || !/^[0-9]$/.test(action.digit)) return state;
      return { ...state, cameraChallenge: (state.cameraChallenge + action.digit).slice(-6) };
    case 'FOLDERS_LOADED':
      return { ...state, folders: action.folders, loading: false, error: null };
    case 'OPEN_FOLDER':
      if (!state.folders.some((folder) => folder.id === action.id)) return state;
      return {
        ...state, screen: 'folder', folderId: action.id, photos: [],
        photoIndex: 0, playing: false, loading: true, error: null,
      };
    case 'PHOTOS_LOADED':
      if (action.folderId !== state.folderId) return state;
      return { ...state, photos: action.photos, loading: false, error: null };
    case 'OPEN_PHOTO':
      if (!Number.isInteger(action.index) || !state.photos[action.index]) return state;
      return { ...state, screen: 'photo', photoIndex: action.index, playing: false };
    case 'STEP':
    case 'TICK': {
      if (state.screen !== 'photo' || !state.photos.length) return state;
      if (action.type === 'TICK' && !state.playing) return state;
      const step = action.type === 'TICK' ? 1 : Math.sign(action.delta || 0);
      return {
        ...state,
        photoIndex: (state.photoIndex + step + state.photos.length) % state.photos.length,
      };
    }
    case 'TOGGLE_SLIDESHOW':
      if (state.screen !== 'photo' || !state.photos.length) return state;
      return { ...state, playing: !state.playing };
    case 'SET_PLAYING':
      if (state.screen !== 'photo' || !state.photos.length) return state;
      return { ...state, playing: Boolean(action.playing) };
    case 'NAVIGATE':
      if (!['folders', 'diagnostics', 'signin'].includes(action.screen)) return state;
      if (state.screen === action.screen) return state;
      return {
        ...state,
        screen: action.screen,
        returnScreen: ['diagnostics', 'signin'].includes(state.screen)
          ? state.returnScreen : state.screen,
        playing: false,
      };
    case 'BACK':
      if (state.playing) return { ...state, playing: false };
      if (state.screen === 'photo') return { ...state, screen: 'folder' };
      if (state.screen === 'folder') return { ...state, screen: 'folders' };
      if (state.screen === 'diagnostics' || state.screen === 'signin') {
        return { ...state, screen: state.returnScreen, playing: false };
      }
      return { ...state, screen: 'diagnostics', returnScreen: 'folders' };
    case 'LOAD_ERROR':
      if (action.folderId && action.folderId !== state.folderId) return state;
      return { ...state, loading: false, error: String(action.message) };
    default:
      return state;
  }
}

export function focusContext(state) {
  return state.screen === 'folder' ? `folder:${state.folderId}` : state.screen;
}
