export function ConfirmModal({
  title,
  message,
  detail,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  detail: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="modal-box">
        <div className="panel-head">
          <h2>{title}</h2>
        </div>
        <p>{message}</p>
        <p className="note" style={{ whiteSpace: 'pre-line' }}>
          {detail}
        </p>
        <div className="row2">
          <button className="ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="primary" onClick={onConfirm}>
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
