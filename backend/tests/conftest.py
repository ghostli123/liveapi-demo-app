import os
import sys

from absl import flags

# Backend modules import each other by bare name (e.g. `import get_credentials`).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Tests read flag defaults without going through absl's app.run().
flags.FLAGS.mark_as_parsed()
