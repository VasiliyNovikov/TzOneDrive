const photo = (id, title, palette, description) => Object.freeze({
  id, title, palette, description,
  thumbnail: `./assets/photos/${id}.svg`,
  full: `./assets/photos/${id}.svg`,
});

const coast = [
  photo('coast', 'Where the land meets the sea', 'Atlantic blue', 'A turquoise bay beneath a quiet coastal headland.'),
  photo('dunes', 'A softer horizon', 'Sand & sky', 'Golden sand dunes rolling toward a pale blue sky.'),
  photo('sail', 'Nowhere to hurry', 'Late afternoon', 'A small white sailboat on a still blue sea.'),
  photo('tide', 'The shape of the tide', 'Sea glass', 'Layers of teal water and white surf along the shore.'),
  photo('lighthouse', 'The way home', 'Evening glow', 'A small lighthouse above a sunlit ocean.'),
  photo('sunset', 'One more minute', 'Coral hour', 'A coral sun setting across calm purple water.'),
];
const alpine = [
  photo('mountains', 'Above the everyday', 'Alpine morning', 'Snow-capped mountain peaks under a clear sky.'),
  photo('lake', 'A place to pause', 'Glacial green', 'Still green lake water reflecting a mountain valley.'),
  photo('forest', 'Take the long way', 'Forest light', 'A sunbeam falling through layers of evergreen trees.'),
];
const desert = [
  coast[1],
  photo('mesa', 'The quiet is enormous', 'Terracotta', 'Red desert mesas beneath a warm cream sky.'),
  photo('arch', 'Made by time', 'Desert rose', 'An ochre sandstone arch in a pink desert landscape.'),
];

const collections = [
  { id: 'coastal-quiet', title: 'Coastal quiet', subtitle: 'A little closer to the water', photos: coast },
  { id: 'alpine-light', title: 'Alpine light', subtitle: 'Room to breathe', photos: alpine },
  { id: 'desert-days', title: 'Desert days', subtitle: 'Follow the warm light', photos: desert },
];

// Future delegated, personal, read-only providers implement these same async methods.
// Tokens and Graph transport belong inside that provider, never in the state or renderer.
export function createFixtureProvider() {
  return Object.freeze({
    id: 'synthetic-offline',
    async getSession() {
      return { mode: 'fixture', authenticated: false, capabilities: ['read'] };
    },
    async beginSignIn() {
      return { available: false, message: 'Microsoft sign-in is not connected in this offline preview.' };
    },
    async listFolders(parentId = null) {
      if (parentId !== null) return [];
      return collections.map(({ photos, ...folder }) => ({
        ...folder, count: photos.length, cover: photos[0].thumbnail,
      }));
    },
    async listPhotos(folderId) {
      const folder = collections.find((entry) => entry.id === folderId);
      if (!folder) throw new Error('This collection is not available.');
      return [...folder.photos];
    },
    getPhotoSource(item, { variant = 'full' } = {}) {
      return variant === 'thumbnail' ? item.thumbnail : item.full;
    },
  });
}
