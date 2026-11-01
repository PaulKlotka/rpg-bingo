// Embedded play must never initialize standalone identity, navigation or saves.
if (location.pathname === '/embed' || location.pathname === '/embed/') {
  void import('./embedded').then(module => module.mountEmbedded());
} else {
  void import('./standalone');
}
