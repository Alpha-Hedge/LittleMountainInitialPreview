"""Guard PDFium calls within each API or worker process."""

from threading import Lock

pdfium_lock = Lock()
