try:
    from .hermes_adapter import register
except ImportError:
    from hermes_adapter import register
