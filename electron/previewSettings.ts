// The renderer owns the persisted preference; new renders omit the preview output.
let previewEnabled = true;
export const isPreviewEnabled = () => previewEnabled;
export const setPreviewEnabled = (enabled: boolean) => { previewEnabled = enabled; };
