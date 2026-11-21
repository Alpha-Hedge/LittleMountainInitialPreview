from io import BytesIO

import numpy as np
import pytest
from PIL import Image, ImageDraw

from packages.cad.preprocessing import reading_copy


def test_approved_corner_rectification_and_pixel_limits():
    image = Image.new("RGB", (240, 180), (237, 233, 216))
    ImageDraw.Draw(image).line((35, 60, 195, 70), fill="black", width=4)
    source = BytesIO()
    image.save(source, format="PNG")
    pixel_copy = reading_copy(source.getvalue(), [[20, 20], [220, 20], [220, 160], [20, 160]])
    gray = Image.open(BytesIO(pixel_copy))
    assert gray.size == (200, 140) and set(np.unique(gray)) == {0, 255}
    for bad in (
        [[20, 20], [220, 160], [20, 160], [220, 20]],
        [[-1, 20], [220, 20], [220, 160], [20, 160]],
    ):
        with pytest.raises(ValueError):
            reading_copy(source.getvalue(), bad)
