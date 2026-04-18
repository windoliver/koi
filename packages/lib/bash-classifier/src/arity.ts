/**
 * ARITY — number of leading tokens that form the canonical permission
 * prefix for a known command.
 *
 * Keys are either a binary name (e.g. `git`) or a two-word form when the
 * second token is a subcommand-style verb (e.g. `npm run`, `docker compose`).
 * Values are the total token count to include in the prefix.
 *
 * Unknown keys default to arity 1 in `prefix()`.
 *
 * Data only — no logic.
 */
export const ARITY: Readonly<Record<string, number>> = Object.freeze({
  // Version control
  git: 2,
  hg: 2,
  svn: 2,
  jj: 2,

  // JS/TS runtime + package managers
  npm: 2,
  "npm run": 3,
  yarn: 2,
  "yarn run": 3,
  pnpm: 2,
  "pnpm run": 3,
  bun: 2,
  "bun run": 3,
  "bun add": 3,
  "bun x": 3,
  npx: 2,
  bunx: 2,
  deno: 2,
  "deno run": 3,
  "deno task": 3,

  // Containers + orchestration
  docker: 2,
  "docker compose": 3,
  "docker buildx": 3,
  podman: 2,
  "podman compose": 3,
  kubectl: 2,
  helm: 2,

  // Cloud CLIs
  aws: 2,
  gcloud: 2,
  gsutil: 2,
  az: 2,
  doctl: 2,
  flyctl: 2,
  fly: 2,
  heroku: 2,

  // SCM clients
  gh: 2,
  "gh api": 3,
  "gh pr": 3,
  "gh issue": 3,
  glab: 2,

  // Python tooling
  pip: 2,
  pip3: 2,
  pipx: 2,
  poetry: 2,
  uv: 2,
  "uv run": 3,
  "uv pip": 3,
  conda: 2,

  // Build / compilers / runtimes
  cargo: 2,
  go: 2,
  rustup: 2,
  rustc: 1,
  maven: 2,
  mvn: 2,
  gradle: 2,
  make: 1,

  // Testing
  pytest: 1,
  jest: 1,
  vitest: 1,

  // System package managers
  apt: 2,
  "apt-get": 2,
  yum: 2,
  dnf: 2,
  pacman: 2,
  brew: 2,
  "brew services": 3,
  port: 2,
  apk: 2,
  snap: 2,

  // Service management
  systemctl: 2,
  "systemctl --user": 3,
  service: 2,
  launchctl: 2,

  // Shell + editors (single-token commands listed to pin arity at 1 explicitly)
  bash: 1,
  sh: 1,
  zsh: 1,
  fish: 1,
  ls: 1,
  cat: 1,
  head: 1,
  tail: 1,
  grep: 1,
  rg: 1,
  find: 1,
  fd: 1,
  sed: 1,
  awk: 1,
  cut: 1,
  sort: 1,
  uniq: 1,
  wc: 1,
  echo: 1,
  printf: 1,
  pwd: 1,
  cd: 1,
  mkdir: 1,
  rm: 1,
  cp: 1,
  mv: 1,
  ln: 1,
  touch: 1,
  chmod: 1,
  chown: 1,

  // Archiving / transfer
  tar: 1,
  zip: 1,
  unzip: 1,
  gzip: 1,
  gunzip: 1,
  curl: 1,
  wget: 1,
  rsync: 1,
  scp: 1,
  ssh: 1,

  // Misc commonly-scripted
  env: 1,
  xargs: 1,
  sudo: 1,
  nohup: 1,
  timeout: 1,
  watch: 1,
  tmux: 2,
  screen: 1,
  code: 2,
  pbcopy: 1,
  pbpaste: 1,

  // Databases
  psql: 1,
  mysql: 1,
  sqlite3: 1,
  redis: 2,
  "redis-cli": 1,
  mongosh: 1,
});
