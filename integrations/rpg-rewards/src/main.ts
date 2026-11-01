if (location.pathname === '/embed' || location.pathname === '/embed/') {
  void import('./embedded').then(module => module.mountEmbedded());
} else {
  document.querySelector('#app')!.innerHTML = '<main style="font-family:system-ui;padding:2rem"><h1>RPG Rewards</h1><p>Your rewards are available in Between Turns.</p><a href="https://between-turns-paul.web.app/">Open Between Turns</a></main>';
}
