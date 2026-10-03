export default async function* reporter(source) {
  for await (const event of source) {
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      yield JSON.stringify({
        type: event.type,
        file: event.data.file,
        name: event.data.name,
        skip: Boolean(event.data.skip),
        todo: Boolean(event.data.todo),
      }) + '\n';
    }
  }
}
