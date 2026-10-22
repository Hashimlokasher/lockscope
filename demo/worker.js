self.onmessage = async (event) => {
  const { name, ms } = event.data || {};
  if (!name) return;

  self.postMessage({ message: `requesting ${name}` });

  try {
    await navigator.locks.request(name, async () => {
      self.postMessage({ message: `holding ${name} in worker` });
      await new Promise((resolve) => setTimeout(resolve, ms || 8000));
      self.postMessage({ message: `releasing ${name}` });
    });
    self.postMessage({ message: "done", done: true });
  } catch (error) {
    self.postMessage({ message: `error: ${error.message}`, done: true });
  }
};
